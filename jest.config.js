/** Jest configuration for the Tengo mobile foundation (T1).
 *
 * Uses the `jest-expo` preset (Expo SDK 57 docs: "Unit testing with Jest"),
 * which mocks Expo native modules and wires the React Native transform.
 * `jest.setup.ts` declares the mocked SQL/native boundary: unit tests never
 * touch a real SQLite file. Real persistence is verified on a native
 * emulator/device build (see README "Native testing limits").
 */
module.exports = {
  preset: 'jest-expo',
  setupFiles: ['<rootDir>/jest.setup.ts'],
};
