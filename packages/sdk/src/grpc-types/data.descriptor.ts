// AUTO-GENERATED — do not edit by hand.
// Source: data.proto
// Package: oneplatform.v1

import type * as Msgs from "./data.js";

// RpcDescriptor carries the streaming flags needed by the gRPC-Web handler
// to correctly frame server-streaming and client-streaming calls.
export interface RpcDescriptor {
  readonly name: string;
  readonly inputType: string;
  readonly outputType: string;
  readonly clientStreaming: boolean;
  readonly serverStreaming: boolean;
}

export interface ServiceDescriptor {
  readonly name: string;
  readonly rpcs: readonly RpcDescriptor[];
}

export const DataServiceDescriptor: ServiceDescriptor = {
  name: "DataService",
  rpcs: [
    {
      name: "GetEntity",
      inputType: "GetEntityRequest",
      outputType: "Entity",
      clientStreaming: false,
      serverStreaming: false,
    },
    {
      name: "ListEntities",
      inputType: "ListEntitiesRequest",
      outputType: "ListEntitiesResponse",
      clientStreaming: false,
      serverStreaming: false,
    },
    {
      name: "CreateEntity",
      inputType: "CreateEntityRequest",
      outputType: "Entity",
      clientStreaming: false,
      serverStreaming: false,
    },
    {
      name: "UpdateEntity",
      inputType: "UpdateEntityRequest",
      outputType: "Entity",
      clientStreaming: false,
      serverStreaming: false,
    },
    {
      name: "DeleteEntity",
      inputType: "DeleteEntityRequest",
      outputType: "DeleteEntityResponse",
      clientStreaming: false,
      serverStreaming: false,
    },
    {
      name: "StreamEntities",
      inputType: "StreamEntitiesRequest",
      outputType: "Entity",
      clientStreaming: false,
      serverStreaming: true,
    },
    {
      name: "BulkIngest",
      inputType: "IngestRecord",
      outputType: "BulkIngestResponse",
      clientStreaming: true,
      serverStreaming: false,
    },
  ],
};

export interface DataServiceImpl {
  GetEntity(request: Msgs.GetEntityRequest): Promise<Msgs.Entity>;
  ListEntities(request: Msgs.ListEntitiesRequest): Promise<Msgs.ListEntitiesResponse>;
  CreateEntity(request: Msgs.CreateEntityRequest): Promise<Msgs.Entity>;
  UpdateEntity(request: Msgs.UpdateEntityRequest): Promise<Msgs.Entity>;
  DeleteEntity(request: Msgs.DeleteEntityRequest): Promise<Msgs.DeleteEntityResponse>;
  StreamEntities(request: Msgs.StreamEntitiesRequest): AsyncIterable<Msgs.Entity>;
  BulkIngest(stream: AsyncIterable<Msgs.IngestRecord>): Promise<Msgs.BulkIngestResponse>;
}
