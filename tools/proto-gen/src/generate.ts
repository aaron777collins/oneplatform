#!/usr/bin/env node
/**
 * proto-gen — generates TypeScript interface files from .proto definitions.
 *
 * WHY custom codegen instead of protoc + ts-proto:
 *   protoc requires a native binary and the grpc ecosystem adds heavy native
 *   deps (grpc-js). Our gRPC-Web implementation uses JSON serialization with
 *   a gRPC-Web framing envelope, so we only need TypeScript shapes that mirror
 *   the proto message fields — no runtime serialization library required.
 *
 * The generator reads .proto files, extracts message and service definitions,
 * and emits typed TypeScript interfaces plus a service descriptor used by the
 * gRPC-Web handler registry.
 *
 * Usage:
 *   npx tsx tools/proto-gen/src/generate.ts \
 *     --proto-dir proto/oneplatform/v1 \
 *     --out packages/sdk/src/grpc-types
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Proto parser — minimal parser sufficient for our schema conventions.
// Handles: message, enum, service, rpc, stream keyword, repeated, field types.
// Does not handle: imports, options, nested messages, oneof (not in our protos).
// ---------------------------------------------------------------------------

interface ProtoField {
  name: string;
  type: string;
  repeated: boolean;
  fieldNumber: number;
}

interface ProtoMessage {
  name: string;
  fields: ProtoField[];
}

interface ProtoRpc {
  name: string;
  inputType: string;
  outputType: string;
  clientStreaming: boolean;
  serverStreaming: boolean;
}

interface ProtoService {
  name: string;
  rpcs: ProtoRpc[];
}

interface ParsedProto {
  packageName: string;
  messages: ProtoMessage[];
  services: ProtoService[];
}

const PROTO_TO_TS: Record<string, string> = {
  string: "string",
  bool: "boolean",
  int32: "number",
  int64: "number",
  uint32: "number",
  uint64: "number",
  float: "number",
  double: "number",
  bytes: "Uint8Array",
};

function resolveFieldType(protoType: string): string {
  return PROTO_TO_TS[protoType] ?? protoType;
}

function parseProto(source: string): ParsedProto {
  const messages: ProtoMessage[] = [];
  const services: ProtoService[] = [];
  let packageName = "";

  // Strip block comments and line comments
  const stripped = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");

  // Extract package
  const pkgMatch = /^package\s+([\w.]+)\s*;/m.exec(stripped);
  if (pkgMatch) {
    packageName = pkgMatch[1] ?? "";
  }

  // Extract messages
  const msgRegex = /message\s+(\w+)\s*\{([^}]*)\}/g;
  let msgMatch: RegExpExecArray | null;
  while ((msgMatch = msgRegex.exec(stripped)) !== null) {
    const msgName = msgMatch[1] ?? "";
    const body = msgMatch[2] ?? "";
    const fields: ProtoField[] = [];

    // Match field declarations: [repeated] type name = fieldNumber;
    const fieldRegex = /(?:(repeated)\s+)?(\w+)\s+(\w+)\s*=\s*(\d+)\s*;/g;
    let fieldMatch: RegExpExecArray | null;
    while ((fieldMatch = fieldRegex.exec(body)) !== null) {
      fields.push({
        name: fieldMatch[3] ?? "",
        type: fieldMatch[2] ?? "",
        repeated: fieldMatch[1] === "repeated",
        fieldNumber: parseInt(fieldMatch[4] ?? "0", 10),
      });
    }

    messages.push({ name: msgName, fields });
  }

  // Extract services
  const svcRegex = /service\s+(\w+)\s*\{([^}]*)\}/g;
  let svcMatch: RegExpExecArray | null;
  while ((svcMatch = svcRegex.exec(stripped)) !== null) {
    const svcName = svcMatch[1] ?? "";
    const body = svcMatch[2] ?? "";
    const rpcs: ProtoRpc[] = [];

    // Match rpc declarations
    const rpcRegex =
      /rpc\s+(\w+)\s*\(\s*(stream\s+)?(\w+)\s*\)\s*returns\s*\(\s*(stream\s+)?(\w+)\s*\)/g;
    let rpcMatch: RegExpExecArray | null;
    while ((rpcMatch = rpcRegex.exec(body)) !== null) {
      rpcs.push({
        name: rpcMatch[1] ?? "",
        inputType: rpcMatch[3] ?? "",
        outputType: rpcMatch[5] ?? "",
        clientStreaming: rpcMatch[2] !== undefined,
        serverStreaming: rpcMatch[4] !== undefined,
      });
    }

    services.push({ name: svcName, rpcs });
  }

  return { packageName, messages, services };
}

// ---------------------------------------------------------------------------
// TypeScript emitter
// ---------------------------------------------------------------------------

function emitInterfaces(parsed: ParsedProto, fileName: string): string {
  const lines: string[] = [
    "// AUTO-GENERATED — do not edit by hand.",
    `// Source: ${fileName}`,
    `// Package: ${parsed.packageName}`,
    "// Re-run tools/proto-gen/src/generate.ts to regenerate.",
    "",
  ];

  for (const msg of parsed.messages) {
    lines.push(`export interface ${msg.name} {`);
    for (const field of msg.fields) {
      const tsType = resolveFieldType(field.type);
      const arrayType = field.repeated ? `${tsType}[]` : tsType;
      // camelCase conversion: proto uses snake_case
      const camelName = field.name.replace(/_([a-z])/g, (_, c: string) =>
        c.toUpperCase()
      );
      lines.push(`  ${camelName}: ${arrayType};`);
    }
    lines.push("}");
    lines.push("");
  }

  return lines.join("\n");
}

function emitServiceDescriptor(parsed: ParsedProto, fileName: string): string {
  const lines: string[] = [
    "// AUTO-GENERATED — do not edit by hand.",
    `// Source: ${fileName}`,
    `// Package: ${parsed.packageName}`,
    "",
    `import type * as Msgs from "./${fileName.replace(".proto", "")}.js";`,
    "",
    "// RpcDescriptor carries the streaming flags needed by the gRPC-Web handler",
    "// to correctly frame server-streaming and client-streaming calls.",
    "export interface RpcDescriptor {",
    "  readonly name: string;",
    "  readonly inputType: string;",
    "  readonly outputType: string;",
    "  readonly clientStreaming: boolean;",
    "  readonly serverStreaming: boolean;",
    "}",
    "",
    "export interface ServiceDescriptor {",
    "  readonly name: string;",
    "  readonly rpcs: readonly RpcDescriptor[];",
    "}",
    "",
  ];

  for (const svc of parsed.services) {
    lines.push(
      `export const ${svc.name}Descriptor: ServiceDescriptor = {`
    );
    lines.push(`  name: "${svc.name}",`);
    lines.push(`  rpcs: [`);
    for (const rpc of svc.rpcs) {
      lines.push(`    {`);
      lines.push(`      name: "${rpc.name}",`);
      lines.push(`      inputType: "${rpc.inputType}",`);
      lines.push(`      outputType: "${rpc.outputType}",`);
      lines.push(`      clientStreaming: ${rpc.clientStreaming},`);
      lines.push(`      serverStreaming: ${rpc.serverStreaming},`);
      lines.push(`    },`);
    }
    lines.push(`  ],`);
    lines.push(`};`);
    lines.push("");

    // Emit the service interface so implementations are type-checked.
    lines.push(`export interface ${svc.name}Impl {`);
    for (const rpc of svc.rpcs) {
      const inputType = `Msgs.${rpc.inputType}`;
      const outputType = `Msgs.${rpc.outputType}`;

      if (rpc.clientStreaming && rpc.serverStreaming) {
        lines.push(
          `  ${rpc.name}(stream: AsyncIterable<${inputType}>): AsyncIterable<${outputType}>;`
        );
      } else if (rpc.clientStreaming) {
        lines.push(
          `  ${rpc.name}(stream: AsyncIterable<${inputType}>): Promise<${outputType}>;`
        );
      } else if (rpc.serverStreaming) {
        lines.push(
          `  ${rpc.name}(request: ${inputType}): AsyncIterable<${outputType}>;`
        );
      } else {
        lines.push(
          `  ${rpc.name}(request: ${inputType}): Promise<${outputType}>;`
        );
      }
    }
    lines.push(`}`);
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): { protoDir: string; outDir: string } {
  let protoDir = "proto/oneplatform/v1";
  let outDir = "packages/sdk/src/grpc-types";
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--proto-dir" && argv[i + 1] !== undefined) {
      protoDir = argv[i + 1] as string;
      i++;
    } else if (argv[i] === "--out" && argv[i + 1] !== undefined) {
      outDir = argv[i + 1] as string;
      i++;
    }
  }
  return { protoDir, outDir };
}

async function main(): Promise<void> {
  const { protoDir, outDir } = parseArgs(process.argv);

  const absProtoDir = resolve(protoDir);
  const absOutDir = resolve(outDir);

  await mkdir(absOutDir, { recursive: true });

  const files = (await readdir(absProtoDir)).filter((f) =>
    f.endsWith(".proto")
  );

  if (files.length === 0) {
    throw new Error(`No .proto files found in ${absProtoDir}`);
  }

  const indexLines: string[] = [
    "// AUTO-GENERATED barrel — do not edit by hand.",
    "",
  ];

  for (const file of files) {
    const source = await readFile(join(absProtoDir, file), "utf-8");
    const parsed = parseProto(source);
    const baseName = file.replace(".proto", "");

    // Emit message interfaces
    const interfaces = emitInterfaces(parsed, file);
    await writeFile(join(absOutDir, `${baseName}.ts`), interfaces);

    // Emit service descriptor + impl interface
    const descriptor = emitServiceDescriptor(parsed, file);
    await writeFile(
      join(absOutDir, `${baseName}.descriptor.ts`),
      descriptor
    );

    indexLines.push(`export * from "./${baseName}.js";`);
    indexLines.push(`export * from "./${baseName}.descriptor.js";`);
  }

  indexLines.push("");
  await writeFile(join(absOutDir, "index.ts"), indexLines.join("\n"));

  console.info(`proto-gen: generated ${files.length} proto file(s) → ${absOutDir}`);
}

main().catch((err: unknown) => {
  console.error("proto-gen failed:", err);
  process.exit(1);
});
