import { describe, it, expect, afterEach } from "vitest";
import { useWizardStore } from "@/stores/wizard.store";

// ---------------------------------------------------------------------------
// Reset the singleton via the store's own reset action between tests
// ---------------------------------------------------------------------------

afterEach(() => {
  useWizardStore.getState().reset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("useWizardStore", () => {
  describe("initial state", () => {
    it("currentStep is 0", () => {
      expect(useWizardStore.getState().currentStep).toBe(0);
    });

    it("adminEmail is empty string", () => {
      expect(useWizardStore.getState().adminEmail).toBe("");
    });

    it("adminPassword is empty string", () => {
      expect(useWizardStore.getState().adminPassword).toBe("");
    });

    it("orgName is empty string", () => {
      expect(useWizardStore.getState().orgName).toBe("");
    });

    it("masterKeyAcknowledged is false", () => {
      expect(useWizardStore.getState().masterKeyAcknowledged).toBe(false);
    });
  });

  describe("next", () => {
    it("advances from step 0 to step 1", () => {
      useWizardStore.getState().next();
      expect(useWizardStore.getState().currentStep).toBe(1);
    });

    it("advances from step 4 to step 5", () => {
      useWizardStore.getState().goToStep(4);
      useWizardStore.getState().next();
      expect(useWizardStore.getState().currentStep).toBe(5);
    });

    it("does not advance past step 5 (boundary guard)", () => {
      useWizardStore.getState().goToStep(5);
      useWizardStore.getState().next();
      // Step must remain at the last wizard screen
      expect(useWizardStore.getState().currentStep).toBe(5);
    });
  });

  describe("prev", () => {
    it("goes back from step 1 to step 0", () => {
      useWizardStore.getState().goToStep(1);
      useWizardStore.getState().prev();
      expect(useWizardStore.getState().currentStep).toBe(0);
    });

    it("does not go before step 0 (boundary guard)", () => {
      // Already at step 0 after reset; calling prev must be a no-op
      useWizardStore.getState().prev();
      expect(useWizardStore.getState().currentStep).toBe(0);
    });
  });

  describe("goToStep", () => {
    it("sets currentStep to 3", () => {
      useWizardStore.getState().goToStep(3);
      expect(useWizardStore.getState().currentStep).toBe(3);
    });

    it("jumps from step 5 back to step 0", () => {
      useWizardStore.getState().goToStep(5);
      useWizardStore.getState().goToStep(0);
      expect(useWizardStore.getState().currentStep).toBe(0);
    });
  });

  describe("updateField", () => {
    it("updates adminEmail", () => {
      useWizardStore.getState().updateField("adminEmail", "x@example.com");
      expect(useWizardStore.getState().adminEmail).toBe("x@example.com");
    });

    it("leaves other fields unchanged when only adminEmail is updated", () => {
      useWizardStore.getState().updateField("adminEmail", "x@example.com");
      const state = useWizardStore.getState();
      // The fields that were not touched must remain at their initial values
      expect(state.adminPassword).toBe("");
      expect(state.orgName).toBe("");
      expect(state.masterKeyAcknowledged).toBe(false);
    });

    it("updates boolean field masterKeyAcknowledged to true", () => {
      useWizardStore.getState().updateField("masterKeyAcknowledged", true);
      expect(useWizardStore.getState().masterKeyAcknowledged).toBe(true);
    });
  });

  describe("reset", () => {
    it("clears all fields back to initial values", () => {
      // Dirty the store with various values
      useWizardStore.getState().goToStep(3);
      useWizardStore.getState().updateField("adminEmail", "admin@corp.com");
      useWizardStore.getState().updateField("adminPassword", "s3cr3t");
      useWizardStore.getState().updateField("orgName", "Acme");
      useWizardStore.getState().updateField("masterKeyAcknowledged", true);

      useWizardStore.getState().reset();

      const state = useWizardStore.getState();
      expect(state.currentStep).toBe(0);
      expect(state.adminEmail).toBe("");
      expect(state.adminPassword).toBe("");
      expect(state.orgName).toBe("");
      expect(state.masterKeyAcknowledged).toBe(false);
    });

    it("currentStep is back to 0 after reset", () => {
      useWizardStore.getState().goToStep(5);
      useWizardStore.getState().reset();
      expect(useWizardStore.getState().currentStep).toBe(0);
    });
  });

  describe("security", () => {
    it("INITIAL_DATA adminPassword is never pre-filled (empty string)", () => {
      // After a fresh reset there must be no credentials in the store
      expect(useWizardStore.getState().adminPassword).toBe("");
    });
  });
});
