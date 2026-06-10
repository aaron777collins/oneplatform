// Ambient type declarations for bcryptjs@2.4.3 which ships without bundled types.
// These match the subset used by this service (hash and compare).
// Full upstream types are available via @types/bcryptjs for projects that use
// more of the API; expand this declaration if additional bcryptjs methods are needed.

declare module "bcryptjs" {
  /**
   * Generates a bcrypt hash for the given plaintext at the specified cost factor.
   * @param data    Plaintext string to hash
   * @param saltOrRounds  Number of rounds (cost factor) or pre-generated salt string
   */
  export function hash(data: string, saltOrRounds: number | string): Promise<string>;

  /**
   * Compares a plaintext string against a bcrypt hash.
   * Returns true if the plaintext matches the hash, false otherwise.
   */
  export function compare(data: string, encrypted: string): Promise<boolean>;

  /**
   * Generates a salt string with the given number of rounds.
   */
  export function genSalt(rounds?: number): Promise<string>;

  /**
   * Generates a bcrypt hash synchronously.
   */
  export function hashSync(data: string, saltOrRounds: number | string): string;

  /**
   * Compares synchronously.
   */
  export function compareSync(data: string, encrypted: string): boolean;
}
