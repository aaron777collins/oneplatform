// AUTO-GENERATED — do not edit by hand.
// Source: ingestion.proto
// Package: oneplatform.v1

import type * as Msgs from "./ingestion.js";

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

export const IngestionServiceDescriptor: ServiceDescriptor = {
  name: "IngestionService",
  rpcs: [
    {
      name: "TriggerSync",
      inputType: "TriggerSyncRequest",
      outputType: "TriggerSyncResponse",
      clientStreaming: false,
      serverStreaming: false,
    },
    {
      name: "GetSyncStatus",
      inputType: "GetSyncStatusRequest",
      outputType: "SyncStatus",
      clientStreaming: false,
      serverStreaming: false,
    },
    {
      name: "StreamSyncEvents",
      inputType: "StreamSyncEventsRequest",
      outputType: "SyncEvent",
      clientStreaming: false,
      serverStreaming: true,
    },
  ],
};

export interface IngestionServiceImpl {
  TriggerSync(request: Msgs.TriggerSyncRequest): Promise<Msgs.TriggerSyncResponse>;
  GetSyncStatus(request: Msgs.GetSyncStatusRequest): Promise<Msgs.SyncStatus>;
  StreamSyncEvents(request: Msgs.StreamSyncEventsRequest): AsyncIterable<Msgs.SyncEvent>;
}
