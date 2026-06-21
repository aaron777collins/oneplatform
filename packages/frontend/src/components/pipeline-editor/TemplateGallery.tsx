/**
 * TemplateGallery — full-screen overlay wizard shown when creating a new pipeline.
 *
 * Flow:
 *   Step 1 — "What triggers this pipeline?" (trigger selector)
 *   Step 2 — "Give it a name" (name input)
 *   Step 3 — "Choose a template or start blank" (template cards + blank option)
 *
 * On completion, the parent receives the chosen TriggerType, pipeline name,
 * and an optional PipelineGraph (undefined means "start from scratch").
 *
 * WHY a 3-step wizard instead of a single form?
 * Non-technical users are overwhelmed by blank canvases with many fields at
 * once. Progressive disclosure surfaces one decision at a time and keeps each
 * step cognitively light.
 */
import * as React from "react";
import {
  Plug,
  ArrowLeftRight,
  Webhook,
  Clock,
  Code2,
  Layers,
  GitBranch,
  Workflow,
  ChevronRight,
  ChevronLeft,
  LayoutTemplate,
  type LucideProps,
} from "lucide-react";
import type { ForwardRefExoticComponent, RefAttributes } from "react";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Badge } from "@/components/ui/badge.js";
import { cn } from "@/lib/utils.js";
import { PIPELINE_TEMPLATES, type PipelineTemplate } from "./pipeline-templates.js";
import type { PipelineGraph } from "./graph-model.js";
import type { TriggerType } from "@/components/pipelines/PipelineCard.js";

// ---------------------------------------------------------------------------
// Icon registry — maps the string key in PipelineTemplate to the lucide component.
// Keeping this map here isolates the icon dependency to the gallery component.
// ---------------------------------------------------------------------------

type IconComponent = ForwardRefExoticComponent<
  Omit<LucideProps, "ref"> & RefAttributes<SVGSVGElement>
>;

const ICON_MAP: Record<string, IconComponent> = {
  Plug,
  ArrowLeftRight,
  Webhook,
  Clock,
  Code2,
  Layers,
  GitBranch,
  Workflow,
};

function resolveIcon(name: string): IconComponent {
  return ICON_MAP[name] ?? LayoutTemplate;
}

// ---------------------------------------------------------------------------
// Trigger option metadata
// ---------------------------------------------------------------------------

interface TriggerOption {
  value: TriggerType;
  label: string;
  description: string;
  icon: IconComponent;
}

const TRIGGER_OPTIONS: TriggerOption[] = [
  {
    value: "manual",
    label: "Manual",
    description: "Run on demand via the UI or API",
    icon: Plug,
  },
  {
    value: "cron",
    label: "Schedule (cron)",
    description: "Run automatically on a time schedule",
    icon: Clock,
  },
  {
    value: "event",
    label: "Webhook / Event",
    description: "Run when an external event arrives",
    icon: Webhook,
  },
];

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TemplateGalleryResult {
  name: string;
  triggerType: TriggerType;
  /** The chosen template graph, or undefined if the user chose "Start blank" */
  graph: PipelineGraph | undefined;
}

export interface TemplateGalleryProps {
  /** Called when the user completes the wizard (template selected or blank) */
  onComplete: (result: TemplateGalleryResult) => void;
  /** Called when the wizard is dismissed (navigates away) */
  onCancel: () => void;
}

// ---------------------------------------------------------------------------
// Wizard steps
// ---------------------------------------------------------------------------

type WizardStep = 1 | 2 | 3;

// ---------------------------------------------------------------------------
// TemplateGallery component
// ---------------------------------------------------------------------------

export function TemplateGallery({ onComplete, onCancel }: TemplateGalleryProps) {
  const [step, setStep] = React.useState<WizardStep>(1);
  const [triggerType, setTriggerType] = React.useState<TriggerType>("manual");
  const [name, setName] = React.useState("");
  const [nameError, setNameError] = React.useState<string | null>(null);

  function handleAdvanceFromStep1() {
    setStep(2);
  }

  function handleAdvanceFromStep2() {
    if (name.trim().length === 0) {
      setNameError("Pipeline name is required.");
      return;
    }
    setNameError(null);
    setStep(3);
  }

  function handleSelectTemplate(template: PipelineTemplate) {
    onComplete({ name: name.trim(), triggerType, graph: template.graph });
  }

  function handleStartBlank() {
    onComplete({ name: name.trim(), triggerType, graph: undefined });
  }

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-[var(--color-background)]"
      role="dialog"
      aria-modal="true"
      aria-label="Create pipeline wizard"
    >
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                               */}
      {/* ------------------------------------------------------------------ */}
      <header className="flex items-center justify-between border-b border-[var(--color-border)] px-6 py-4">
        <div className="flex items-center gap-3">
          <LayoutTemplate className="h-5 w-5 text-[var(--color-primary)]" aria-hidden />
          <h1 className="text-lg font-semibold">Create a new pipeline</h1>
        </div>
        <StepIndicator current={step} />
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Step content                                                         */}
      {/* ------------------------------------------------------------------ */}
      <div className="flex flex-1 flex-col items-center overflow-y-auto px-6 py-10">
        {step === 1 && (
          <Step1Trigger
            value={triggerType}
            onChange={setTriggerType}
            onNext={handleAdvanceFromStep1}
          />
        )}
        {step === 2 && (
          <Step2Name
            value={name}
            error={nameError}
            onChange={(v) => {
              setName(v);
              if (v.trim().length > 0) setNameError(null);
            }}
            onBack={() => setStep(1)}
            onNext={handleAdvanceFromStep2}
          />
        )}
        {step === 3 && (
          <Step3Template
            onBack={() => setStep(2)}
            onSelectTemplate={handleSelectTemplate}
            onStartBlank={handleStartBlank}
          />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepIndicator
// ---------------------------------------------------------------------------

function StepIndicator({ current }: { current: WizardStep }) {
  const steps: { n: WizardStep; label: string }[] = [
    { n: 1, label: "Trigger" },
    { n: 2, label: "Name" },
    { n: 3, label: "Template" },
  ];

  return (
    <nav aria-label="Wizard progress" className="flex items-center gap-2">
      {steps.map((s, idx) => (
        <React.Fragment key={s.n}>
          {idx > 0 && (
            <div
              className={cn(
                "h-px w-8 transition-colors",
                current > s.n - 1
                  ? "bg-[var(--color-primary)]"
                  : "bg-[var(--color-border)]"
              )}
              aria-hidden
            />
          )}
          <div className="flex items-center gap-1.5">
            <span
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full text-xs font-semibold transition-colors",
                current === s.n
                  ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                  : current > s.n
                  ? "bg-[var(--color-primary)]/20 text-[var(--color-primary)]"
                  : "bg-[var(--color-muted)] text-[var(--color-muted-foreground)]"
              )}
              aria-current={current === s.n ? "step" : undefined}
            >
              {s.n}
            </span>
            <span
              className={cn(
                "hidden text-xs sm:inline",
                current === s.n
                  ? "font-semibold text-[var(--color-foreground)]"
                  : "text-[var(--color-muted-foreground)]"
              )}
            >
              {s.label}
            </span>
          </div>
        </React.Fragment>
      ))}
    </nav>
  );
}

// ---------------------------------------------------------------------------
// Step 1 — Trigger type
// ---------------------------------------------------------------------------

interface Step1TriggerProps {
  value: TriggerType;
  onChange: (v: TriggerType) => void;
  onNext: () => void;
}

function Step1Trigger({ value, onChange, onNext }: Step1TriggerProps) {
  return (
    <section className="w-full max-w-2xl space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-semibold">What triggers this pipeline?</h2>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          You can always change this later.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3" role="radiogroup" aria-label="Trigger type">
        {TRIGGER_OPTIONS.map((opt) => {
          const Icon = opt.icon;
          const selected = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => onChange(opt.value)}
              className={cn(
                "flex flex-col items-start gap-3 rounded-lg border p-4 text-left transition-all",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)]",
                selected
                  ? "border-[var(--color-primary)] bg-[var(--color-primary)]/5"
                  : "border-[var(--color-border)] bg-[var(--color-card)] hover:border-[var(--color-primary)]/40 hover:bg-[var(--color-muted)]"
              )}
            >
              <div
                className={cn(
                  "rounded-md p-2",
                  selected
                    ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                    : "bg-[var(--color-muted)] text-[var(--color-muted-foreground)]"
                )}
              >
                <Icon className="h-5 w-5" aria-hidden />
              </div>
              <div>
                <p className="text-sm font-semibold">{opt.label}</p>
                <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5">
                  {opt.description}
                </p>
              </div>
            </button>
          );
        })}
      </div>

      <div className="flex justify-end">
        <Button onClick={onNext}>
          Next
          <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 2 — Pipeline name
// ---------------------------------------------------------------------------

interface Step2NameProps {
  value: string;
  error: string | null;
  onChange: (v: string) => void;
  onBack: () => void;
  onNext: () => void;
}

function Step2Name({ value, error, onChange, onBack, onNext }: Step2NameProps) {
  // Auto-focus the input when the step mounts so the user can type immediately
  const inputRef = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      onNext();
    }
  }

  return (
    <section className="w-full max-w-md space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-semibold">Give it a name</h2>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          A clear name makes it easy to find later.
        </p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="wizard-pipeline-name">
          Pipeline name
          <span className="ml-1 text-[var(--color-destructive)]" aria-hidden>*</span>
        </Label>
        <Input
          id="wizard-pipeline-name"
          ref={inputRef}
          placeholder="e.g. Sync customers daily"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          aria-invalid={error !== null ? true : undefined}
          aria-describedby={error !== null ? "wizard-name-error" : undefined}
        />
        {error !== null && (
          <p
            id="wizard-name-error"
            className="text-xs text-[var(--color-destructive)]"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
          Back
        </Button>
        <Button onClick={onNext}>
          Next
          <ChevronRight className="ml-1 h-4 w-4" aria-hidden />
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Step 3 — Template selection
// ---------------------------------------------------------------------------

interface Step3TemplateProps {
  onBack: () => void;
  onSelectTemplate: (template: PipelineTemplate) => void;
  onStartBlank: () => void;
}

function Step3Template({ onBack, onSelectTemplate, onStartBlank }: Step3TemplateProps) {
  return (
    <section className="w-full max-w-4xl space-y-6">
      <div className="text-center">
        <h2 className="text-2xl font-semibold">Choose a template</h2>
        <p className="mt-1 text-sm text-[var(--color-muted-foreground)]">
          Start with a pre-built pipeline or build from scratch.
        </p>
      </div>

      {/* Template grid */}
      <div
        className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        role="list"
        aria-label="Pipeline templates"
      >
        {PIPELINE_TEMPLATES.map((template) => (
          <TemplateCard
            key={template.key}
            template={template}
            onSelect={onSelectTemplate}
          />
        ))}
      </div>

      {/* Start from scratch option */}
      <div className="rounded-lg border border-dashed border-[var(--color-border)] p-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-semibold">Start from scratch</p>
            <p className="text-xs text-[var(--color-muted-foreground)] mt-0.5">
              Open the visual editor with an empty canvas. Best for advanced users.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={onStartBlank} className="shrink-0">
            Blank canvas
          </Button>
        </div>
      </div>

      <div className="flex justify-between">
        <Button variant="outline" onClick={onBack}>
          <ChevronLeft className="mr-1 h-4 w-4" aria-hidden />
          Back
        </Button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// TemplateCard
// ---------------------------------------------------------------------------

interface TemplateCardProps {
  template: PipelineTemplate;
  onSelect: (template: PipelineTemplate) => void;
}

function TemplateCard({ template, onSelect }: TemplateCardProps) {
  const Icon = resolveIcon(template.icon);

  return (
    <Card
      role="listitem"
      className={cn(
        "cursor-pointer transition-all",
        "hover:border-[var(--color-primary)]/40 hover:shadow-md",
        "focus-within:ring-2 focus-within:ring-[var(--color-primary)]"
      )}
    >
      <button
        type="button"
        className="flex h-full w-full flex-col gap-3 p-4 text-left focus-visible:outline-none"
        onClick={() => onSelect(template)}
        aria-label={`Use template: ${template.name}`}
      >
        <div className="flex items-start justify-between gap-2">
          <div className="rounded-md bg-[var(--color-primary)]/10 p-2 text-[var(--color-primary)]">
            <Icon className="h-5 w-5" aria-hidden />
          </div>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {template.nodeCount} nodes
          </Badge>
        </div>
        <div>
          <CardContent className="p-0">
            <p className="text-sm font-semibold leading-snug">{template.name}</p>
            <p className="mt-1 text-xs leading-relaxed text-[var(--color-muted-foreground)]">
              {template.description}
            </p>
          </CardContent>
        </div>
      </button>
    </Card>
  );
}
