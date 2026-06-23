import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ContainerInfo, ContainerInspectInfo } from "dockerode";

// Mock the dockerClient module so route handlers operate against controlled
// fixtures instead of a real Docker daemon.
vi.mock("../docker/dockerClient.js", () => ({
  listContainers: vi.fn(),
  getContainer: vi.fn(),
  getContainerLogs: vi.fn(),
  getContainerStats: vi.fn(),
  containerAction: vi.fn(),
}));

import {
  listContainers,
  getContainer,
  containerAction,
} from "../docker/dockerClient.js";
import { createContainerRoutes } from "../routes/containers.js";
import { ContainerNotFoundError, ContainerRunningError } from "../errors.js";

const app = createContainerRoutes();

const VALID_ID = "abcdef0123456789abcdef0123456789abcdef01";

function req(path: string, init?: RequestInit): Promise<Response> {
  return Promise.resolve(app.request(path, init));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /containers", () => {
  it("returns the transformed container list", async () => {
    vi.mocked(listContainers).mockResolvedValue([
      {
        Id: VALID_ID + "abcdef0123456789abcdef01",
        Names: ["/web"],
        Image: "nginx",
        ImageID: "sha256:x",
        State: "running",
        Status: "Up 1 hour",
        Created: 1_700_000_000,
        Ports: [],
        Labels: {},
        NetworkSettings: { Networks: {} },
      } as unknown as ContainerInfo,
    ]);

    const res = await req("/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string; status: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.name).toBe("web");
    expect(body.data[0]!.status).toBe("running");
  });

  it("filters by status", async () => {
    vi.mocked(listContainers).mockResolvedValue([
      {
        Id: "a".repeat(64),
        Names: ["/run"],
        Image: "x",
        ImageID: "y",
        State: "running",
        Status: "Up",
        Created: 1,
        NetworkSettings: { Networks: {} },
      } as unknown as ContainerInfo,
      {
        Id: "b".repeat(64),
        Names: ["/stop"],
        Image: "x",
        ImageID: "y",
        State: "exited",
        Status: "Exited",
        Created: 1,
        NetworkSettings: { Networks: {} },
      } as unknown as ContainerInfo,
    ]);

    const res = await req("/?status=running");
    const body = (await res.json()) as { data: { name: string }[] };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.name).toBe("run");
  });

  it("returns 503 when the Docker daemon is unreachable", async () => {
    vi.mocked(listContainers).mockRejectedValue(
      Object.assign(new Error("connect ENOENT"), { code: "ENOENT" }),
    );
    const res = await req("/");
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("DOCKER_UNAVAILABLE");
  });
});

describe("GET /containers/:id", () => {
  it("returns container detail", async () => {
    vi.mocked(getContainer).mockResolvedValue({
      Id: "c".repeat(64),
      Name: "/api",
      Image: "sha256:i",
      Created: "2026-06-22T10:00:00.000Z",
      State: {
        Status: "running",
        Running: true,
        Paused: false,
        Restarting: false,
        Dead: false,
        StartedAt: "0001-01-01T00:00:00Z",
      },
      Config: {},
      HostConfig: {},
      NetworkSettings: {},
    } as unknown as ContainerInspectInfo);

    const res = await req(`/${VALID_ID}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { name: string } };
    expect(body.data.name).toBe("api");
  });

  it("rejects an invalid container id with 400", async () => {
    const res = await req("/not-a-valid-id!!");
    expect(res.status).toBe(400);
  });

  it("returns 404 when the container does not exist", async () => {
    vi.mocked(getContainer).mockRejectedValue(new ContainerNotFoundError(VALID_ID));
    const res = await req(`/${VALID_ID}`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONTAINER_NOT_FOUND");
  });
});

describe("container actions", () => {
  it("POST /:id/start returns 204", async () => {
    vi.mocked(containerAction).mockResolvedValue(undefined);
    const res = await req(`/${VALID_ID}/start`, { method: "POST" });
    expect(res.status).toBe(204);
    expect(containerAction).toHaveBeenCalledWith(VALID_ID, "start", {});
  });

  it("POST /:id/stop forwards the timeout", async () => {
    vi.mocked(containerAction).mockResolvedValue(undefined);
    const res = await req(`/${VALID_ID}/stop`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ timeoutSeconds: 30 }),
    });
    expect(res.status).toBe(204);
    expect(containerAction).toHaveBeenCalledWith(VALID_ID, "stop", {
      timeoutSeconds: 30,
    });
  });

  it("DELETE /:id returns 422 when the container is running", async () => {
    vi.mocked(containerAction).mockRejectedValue(
      new ContainerRunningError(VALID_ID),
    );
    const res = await req(`/${VALID_ID}`, { method: "DELETE" });
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("CONTAINER_RUNNING");
  });

  it("DELETE /:id?force=true passes force through", async () => {
    vi.mocked(containerAction).mockResolvedValue(undefined);
    const res = await req(`/${VALID_ID}?force=true`, { method: "DELETE" });
    expect(res.status).toBe(204);
    expect(containerAction).toHaveBeenCalledWith(VALID_ID, "remove", {
      force: true,
    });
  });
});
