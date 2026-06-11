/**
 * EditorPane — Monaco editor instance for the center panel of AppEditor.
 *
 * Monaco is lazy-loaded via dynamic import of @monaco-editor/react so the ~4MB
 * bundle is only fetched when the user navigates to the editor (§11.2).
 *
 * Type declarations are fetched from GET /api/v1/apps/:appId/type-declarations
 * and injected via addExtraLib() so ontology types are available to the app (§11.3).
 *
 * Dirty state is tracked in the editor store; content changes are forwarded to
 * the caller who owns debouncing and saves (§11.4).
 */
import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton.js";
import { useApiClient } from "@/lib/api-client.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EditorPaneProps {
  appId: string;
  filePath: string | null;
  content: string;
  /** Called on every keystroke — caller is responsible for debouncing saves */
  onChange: (content: string) => void;
  className?: string;
}

// ---------------------------------------------------------------------------
// Monaco TypeScript compiler configuration (per §11.3)
// ---------------------------------------------------------------------------

// Loaded lazily — only imported when Monaco is actually available.
// Use import() so this doesn't become a hard dependency at bundle time.
// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type MonacoModule = typeof import("monaco-editor");

function configureMonacoCompilerOptions(monaco: MonacoModule): void {
  // The TypeScript language service is exported as `monaco.typescript` in the
  // ESM bundle — not as `monaco.languages.typescript` (which is deprecated).
  const ts = monaco.typescript;
  ts.typescriptDefaults.setCompilerOptions({
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    jsx: ts.JsxEmit.ReactJSX,
    strict: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    noUnusedLocals: false,
    noUnusedParameters: false,
  });

  ts.typescriptDefaults.setDiagnosticsOptions({
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [],
  });
}

// ---------------------------------------------------------------------------
// Extension → Monaco language id
// ---------------------------------------------------------------------------

function getLanguageForPath(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  const MAP: Record<string, string> = {
    ts: "typescript",
    tsx: "typescript",
    js: "javascript",
    jsx: "javascript",
    json: "json",
    jsonc: "json",
    md: "markdown",
    css: "css",
    html: "html",
    yaml: "yaml",
    yml: "yaml",
  };
  return MAP[ext] ?? "plaintext";
}

// ---------------------------------------------------------------------------
// EditorPane component
// ---------------------------------------------------------------------------

export function EditorPane({ appId, filePath, content, onChange, className }: EditorPaneProps) {
  const client = useApiClient();
  // Lazy-load @monaco-editor/react — only on this route
  const [MonacoEditor, setMonacoEditor] = React.useState<React.ComponentType<{
    value: string;
    language: string;
    onChange?: (value: string | undefined) => void;
    onMount?: (editor: unknown, monaco: MonacoModule) => void;
    loading?: React.ReactNode;
    options?: Record<string, unknown>;
    className?: string;
  }> | null>(null);

  React.useEffect(() => {
    void import("@monaco-editor/react").then((m) => {
      setMonacoEditor(() => m.default as typeof MonacoEditor);
    });
  }, []);

  // Load type declarations once when the editor mounts for this appId
  const typesDeclaredRef = React.useRef<string | null>(null);

  async function handleEditorMount(editor: unknown, monaco: MonacoModule): Promise<void> {
    configureMonacoCompilerOptions(monaco);

    // Only fetch declarations once per appId session
    if (typesDeclaredRef.current === appId) return;
    typesDeclaredRef.current = appId;

    try {
      const response = await client.get<{
        data: { declarations: Array<{ filename: string; content: string }> };
      }>(`/v1/apps/${appId}/type-declarations`);

      for (const decl of response.data.declarations) {
        monaco.typescript.typescriptDefaults.addExtraLib(
          decl.content,
          `file:///node_modules/${decl.filename}`,
        );
      }
    } catch {
      // Type declarations are best-effort — editor remains functional without them
    }
  }

  const language = filePath !== null ? getLanguageForPath(filePath) : "plaintext";

  const loadingFallback = (
    <div className="flex h-full items-center justify-center">
      <div className="space-y-2 w-3/4">
        {Array.from({ length: 12 }).map((_, i) => (
          <Skeleton key={i} className="h-4" style={{ width: `${60 + (i % 5) * 8}%` }} />
        ))}
      </div>
    </div>
  );

  if (filePath === null) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-[var(--color-muted-foreground)]">
        Select a file from the tree to edit
      </div>
    );
  }

  if (MonacoEditor === null) {
    return loadingFallback;
  }

  return (
    <MonacoEditor
      value={content}
      language={language}
      onChange={(value) => onChange(value ?? "")}
      onMount={(editor, monaco) => void handleEditorMount(editor, monaco as MonacoModule)}
      loading={loadingFallback}
      options={{
        minimap: { enabled: false },
        fontSize: 13,
        lineNumbers: "on",
        scrollBeyondLastLine: false,
        automaticLayout: true,
        tabSize: 2,
        insertSpaces: true,
        wordWrap: "on",
        folding: true,
        renderLineHighlight: "line",
        suggestOnTriggerCharacters: true,
        quickSuggestions: true,
      }}
      {...(className !== undefined ? { className } : {})}
    />
  );
}
