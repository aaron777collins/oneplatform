import type { Logger, ServiceTokenSigner } from "@oneplatform/core";
import type { Redis } from "ioredis";
import type { AppRepository } from "../repositories/app-repository.js";
import type { DeploymentRepository } from "../repositories/deployment-repository.js";
import type { PermissionRepository } from "../repositories/permission-repository.js";
import {
  AppNotFoundError,
  AppBuildNotFoundError,
  AppBuildNotReadyError,
  AppBuildArtifactsExpiredError,
  AppOAuthClientRegistrationFailedError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface DeployService {
  deployApp(
    tenantId: string,
    appId: string,
    userId: string,
    buildId?: string
  ): Promise<DeployResult>;

  rollbackApp(
    tenantId: string,
    appId: string,
    userId: string,
    toBuildId: string
  ): Promise<RollbackResult>;
}

export interface DeployResult {
  appId:          string;
  buildId:        string;
  versionNumber:  number;
  deployedAt:     string;
  previousBuildId: string | null;
}

export interface RollbackResult {
  appId:        string;
  fromBuildId:  string;
  toBuildId:    string;
  rolledBackAt: string;
}

export interface DeployServiceDeps {
  appRepo:        AppRepository;
  buildRepo:      DeploymentRepository;
  permRepo:       PermissionRepository;
  redis:          Redis;
  authServiceUrl: string;
  baseUrl:        string;
  logger:         Logger;
  serviceTokenSigner: ServiceTokenSigner;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createDeployService(deps: DeployServiceDeps): DeployService {
  const { appRepo, buildRepo, permRepo, redis, authServiceUrl, baseUrl, logger, serviceTokenSigner } = deps;

  async function deployApp(
    tenantId: string,
    appId: string,
    userId: string,
    buildId?: string
  ): Promise<DeployResult> {
    const app = await appRepo.findByTenantAndId(tenantId, appId);
    if (app === null) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId });
    }

    let targetBuild;
    if (buildId !== undefined) {
      targetBuild = await buildRepo.findByAppAndId(appId, buildId);
      if (targetBuild === null) {
        throw new AppBuildNotFoundError(
          `Build "${buildId}" not found for app "${appId}".`,
          { buildId, appId }
        );
      }
    } else {
      // Deploy latest successful build
      targetBuild = await buildRepo.findLatestSuccessful(appId);
      if (targetBuild === null) {
        throw new AppBuildNotReadyError(
          `No successful build found for app "${appId}".`,
          { appId }
        );
      }
    }

    if (targetBuild.status !== "success") {
      throw new AppBuildNotReadyError(
        `Build "${targetBuild.id}" has status "${targetBuild.status}" — only successful builds can be deployed.`,
        { buildId: targetBuild.id, status: targetBuild.status }
      );
    }

    // Verify artifacts still exist (within retention window)
    if (targetBuild.bundle_path === null) {
      throw new AppBuildArtifactsExpiredError(
        `Build "${targetBuild.id}" has no artifact path — artifacts may have been purged.`,
        { buildId: targetBuild.id }
      );
    }

    const previousBuildId = app.current_build_id;
    const deployedAt = new Date();

    // Atomic pointer swap
    const updated = await appRepo.update(appId, {
      current_build_id: targetBuild.id,
    });
    if (updated === null) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId });
    }

    // Register OAuth client with Auth Service — if this fails, roll back the pointer
    try {
      await registerOAuthClient(app, tenantId);
    } catch (err) {
      // Compensating transaction: revert to previous build
      await appRepo.update(appId, {
        current_build_id: previousBuildId,
      });
      throw new AppOAuthClientRegistrationFailedError(
        `OAuth client registration failed during deploy: ${err instanceof Error ? err.message : String(err)}`,
        { appId, previousBuildId }
      );
    }

    // Publish deploy event
    await redis.publish(
      `events:${tenantId}:app.deployed`,
      JSON.stringify({
        eventType: "app.deployed",
        appId,
        tenantId,
        buildId:        targetBuild.id,
        versionNumber:  targetBuild.version_number,
        deployedAt:     deployedAt.toISOString(),
        deployedBy:     userId,
      })
    );

    logger.info("App deployed", {
      tenantId, appId,
      buildId: targetBuild.id,
      versionNumber: targetBuild.version_number,
      previousBuildId,
    });

    return {
      appId,
      buildId:         targetBuild.id,
      versionNumber:   targetBuild.version_number,
      deployedAt:      deployedAt.toISOString(),
      previousBuildId: previousBuildId,
    };
  }

  async function rollbackApp(
    tenantId: string,
    appId: string,
    userId: string,
    toBuildId: string
  ): Promise<RollbackResult> {
    const app = await appRepo.findByTenantAndId(tenantId, appId);
    if (app === null) {
      throw new AppNotFoundError(`App "${appId}" not found.`, { appId, tenantId });
    }

    const targetBuild = await buildRepo.findByAppAndId(appId, toBuildId);
    if (targetBuild === null) {
      throw new AppBuildNotFoundError(
        `Build "${toBuildId}" not found for app "${appId}".`,
        { buildId: toBuildId, appId }
      );
    }

    if (targetBuild.status !== "success") {
      throw new AppBuildNotReadyError(
        `Cannot rollback to build "${toBuildId}" with status "${targetBuild.status}".`,
        { buildId: toBuildId, status: targetBuild.status }
      );
    }

    if (targetBuild.bundle_path === null) {
      throw new AppBuildArtifactsExpiredError(
        `Build "${toBuildId}" artifacts have been purged — cannot rollback.`,
        { buildId: toBuildId }
      );
    }

    const fromBuildId = app.current_build_id;
    const rolledBackAt = new Date();

    await appRepo.update(appId, { current_build_id: toBuildId });

    // Publish rollback event
    await redis.publish(
      `events:${tenantId}:app.rolled_back`,
      JSON.stringify({
        eventType: "app.rolled_back",
        appId,
        tenantId,
        fromBuildId,
        toBuildId,
        rolledBackAt: rolledBackAt.toISOString(),
        rolledBackBy: userId,
      })
    );

    logger.info("App rolled back", {
      tenantId, appId, fromBuildId, toBuildId,
    });

    return {
      appId,
      fromBuildId: fromBuildId ?? "",
      toBuildId,
      rolledBackAt: rolledBackAt.toISOString(),
    };
  }

  // Registers or updates the OAuth client in the Auth Service. Idempotent.
  // Design spec §9.1
  async function registerOAuthClient(
    app: { id: string; slug: string; access_mode: string; tenant_id: string },
    tenantId: string
  ): Promise<void> {
    const clientId = `app:${app.id}:${tenantId}`;
    const redirectUris = [
      `${baseUrl}/apps/${app.slug}/auth/callback`,
    ];

    const wildcardDomain = process.env["OP_WILDCARD_DOMAIN"];
    if (wildcardDomain !== undefined && wildcardDomain !== "") {
      redirectUris.push(`https://${app.slug}.apps.${wildcardDomain}/auth/callback`);
    }

    const body = {
      clientId,
      clientType:     "public",
      redirectUris,
      allowedScopes:  ["openid", "profile", "data:read", "data:write"],
      tenantId,
      appId:          app.id,
      accessMode:     app.access_mode,
    };

    const token = await serviceTokenSigner.sign();
    const response = await fetch(`${authServiceUrl}/internal/oauth/clients`, {
      method:  "POST",
      headers: {
        "Content-Type":    "application/json",
        "X-Service-Token": token,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Auth Service responded ${response.status}: ${await response.text()}`);
    }

    // Store registration locally to avoid round-trips on every session validation
    await permRepo.upsertOAuthRegistration({
      app_id:      app.id,
      client_id:   clientId,
      access_mode: app.access_mode as "platform-user" | "public",
    });
  }

  return { deployApp, rollbackApp };
}
