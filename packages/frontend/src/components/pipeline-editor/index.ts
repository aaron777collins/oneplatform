/**
 * pipeline-editor barrel export.
 *
 * Import the high-level VisualPipelineEditor for normal use.
 * Specific sub-components are also exported for testing and embedding.
 */
export { VisualPipelineEditor } from "./VisualPipelineEditor.js";
export { PipelineCanvas } from "./PipelineCanvas.js";
export { PipelineNode } from "./PipelineNode.js";
export { ConnectionLine, ArrowheadDef } from "./ConnectionLine.js";
export { NodePalette, PALETTE_DRAG_TYPE_KEY } from "./NodePalette.js";
export { NodeConfigPanel } from "./NodeConfigPanel.js";

export {
  graphToPipelineDefinition,
  pipelineDefinitionToGraph,
  applyAutoLayout,
} from "./graph-converter.js";

export type {
  GraphNode,
  GraphEdge,
  PipelineGraph,
  GraphStepType,
  StepConfig,
  ViewportTransform,
  SelectionState,
} from "./graph-model.js";

export type { ConvertibleDefinition, ConvertibleStep } from "./graph-converter.js";
