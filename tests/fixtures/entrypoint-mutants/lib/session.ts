// Fixture context opener. Matched BY NAME by the scanner options, exactly like
// the real runWithOrganizationAccess.
export async function runWithOrganizationAccess<T>(callback: () => Promise<T>): Promise<T> {
  return callback()
}
