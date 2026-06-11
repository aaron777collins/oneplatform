/**
 * Current user context hook.
 *
 * Returns the user context seeded by AppProvider at mount from GET /bff/me.
 * No network calls per render — the data is already loaded.
 *
 * If called before AppProvider has finished loading (user === null), returns
 * a safe sentinel value with empty strings and isGuest: false rather than
 * throwing or returning null. This avoids conditional hook usage in caller code.
 */

import { useAppContext } from "../provider/AppContext.js";
import type { UserContext } from "../types/entities.js";

const LOADING_SENTINEL: UserContext = {
  id: "",
  email: null,
  displayName: "",
  tenantId: "",
  roles: [],
  isGuest: false,
} as const;

export function useUser(): UserContext {
  const { user } = useAppContext();
  return user ?? LOADING_SENTINEL;
}
