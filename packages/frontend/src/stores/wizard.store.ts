import { create } from "zustand";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Zero-indexed step positions matching the six wizard screens */
export type WizardStep = 0 | 1 | 2 | 3 | 4 | 5;

/** The subset of wizard state that contains user-entered data */
export interface WizardData {
  adminEmail: string;
  adminPassword: string;
  orgName: string;
  masterKeyAcknowledged: boolean;
}

interface WizardState extends WizardData {
  currentStep: WizardStep;

  // Actions
  goToStep: (step: WizardStep) => void;
  next: () => void;
  prev: () => void;
  updateField: <K extends keyof WizardData>(key: K, value: WizardData[K]) => void;
  /**
   * Resets all wizard state. Called after a successful bootstrap POST.
   * The adminPassword is zeroed out immediately after the POST fires
   * (see WizardPage) — this reset clears the remaining fields.
   */
  reset: () => void;
}

const INITIAL_DATA: WizardData = {
  adminEmail: "",
  adminPassword: "",
  orgName: "",
  masterKeyAcknowledged: false,
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export const useWizardStore = create<WizardState>()((set, get) => ({
  currentStep: 0,
  ...INITIAL_DATA,

  goToStep: (step: WizardStep): void => {
    set({ currentStep: step });
  },

  next: (): void => {
    const { currentStep } = get();
    // Guard: do not advance past the last step
    if (currentStep < 5) {
      set({ currentStep: (currentStep + 1) as WizardStep });
    }
  },

  prev: (): void => {
    const { currentStep } = get();
    // Guard: do not go before the first step
    if (currentStep > 0) {
      set({ currentStep: (currentStep - 1) as WizardStep });
    }
  },

  updateField: <K extends keyof WizardData>(key: K, value: WizardData[K]): void => {
    set({ [key]: value } as Pick<WizardState, K>);
  },

  reset: (): void => {
    set({ currentStep: 0, ...INITIAL_DATA });
  },
}));
