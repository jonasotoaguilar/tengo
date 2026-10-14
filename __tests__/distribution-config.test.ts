/**
 * Distribution-preparation contract (U8, S7).
 *
 * Preparation only: `eas.json`, release fields in `app.json`, and the written
 * release process. No EAS project is linked, nothing has been built by EAS,
 * and nothing has been uploaded. These tests assert that contract through the
 * public configuration files so a future edit that breaks preparation fails
 * here: exact profile set, local versioning, typed release fields, no
 * committed credential-shaped values, and a CI release workflow that stays
 * source-only.
 *
 * What this file never claims: no build, submission, device install, or store
 * review is exercised here. Those need the user's Expo/Play credentials and a
 * real upload, which this unit explicitly does not perform.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..');

function readJson(fileName: string): unknown {
  const raw = fs.readFileSync(path.join(REPO_ROOT, fileName), 'utf8');
  return JSON.parse(raw) as unknown;
}

function readText(fileName: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, fileName), 'utf8');
}

describe('distribution preparation contract (no build, no upload)', () => {
  test('eas.json declares exactly the documented android profiles with local versioning', () => {
    const eas = readJson('eas.json') as {
      cli?: { appVersionSource?: unknown };
      build?: Record<string, unknown>;
    };

    expect(eas.cli?.appVersionSource).toBe('local');
    expect(Object.keys(eas.build ?? {}).sort()).toEqual([
      'development',
      'preview',
      'production',
    ]);

    const development = eas.build?.development as {
      developmentClient?: unknown;
      distribution?: unknown;
    };
    expect(development.developmentClient).toBe(true);
    expect(development.distribution).toBe('internal');

    const preview = eas.build?.preview as {
      developmentClient?: unknown;
      distribution?: unknown;
    };
    expect(preview.developmentClient).not.toBe(true);
    expect(preview.distribution).toBe('internal');

    const production = eas.build?.production as {
      developmentClient?: unknown;
      android?: { buildType?: unknown };
    };
    expect(production.developmentClient).not.toBe(true);
    expect(production.android?.buildType).toBe('app-bundle');
  });

  test('eas.json invents no project identity: no owner, no project id', () => {
    const eas = readJson('eas.json') as {
      owner?: unknown;
      extra?: { eas?: { projectId?: unknown } };
    };
    const raw = readText('eas.json');

    expect(eas.owner).toBeUndefined();
    expect(eas.extra?.eas?.projectId).toBeUndefined();
    expect(raw).not.toMatch(/projectId/);
  });

  test('app.json carries typed release fields and a valid package', () => {
    const app = readJson('app.json') as {
      expo?: {
        version?: unknown;
        android?: { package?: unknown; versionCode?: unknown };
      };
    };
    const pkg = readJson('package.json') as { version?: unknown };

    expect(typeof app.expo?.version).toBe('string');
    expect(app.expo?.version).toMatch(/^\d+\.\d+\.\d+$/);
    // Local versioning (cli.appVersionSource "local") makes app.json the
    // source of truth, so it must track package.json, which release.yml tags.
    expect(app.expo?.version).toBe(pkg.version);

    expect(typeof app.expo?.android?.package).toBe('string');
    expect(app.expo?.android?.package as string).toMatch(
      /^[a-z][a-zA-Z0-9_]*(\.[a-z][a-zA-Z0-9_]*)+$/,
    );

    expect(Number.isInteger(app.expo?.android?.versionCode)).toBe(true);
    expect(app.expo?.android?.versionCode as number).toBeGreaterThanOrEqual(1);
  });

  test('no credential-shaped value is committed in eas.json or app.json', () => {
    for (const fileName of ['eas.json', 'app.json']) {
      const raw = readText(fileName);
      expect(raw).not.toMatch(/BEGIN .*PRIVATE KEY/);
      expect(raw).not.toMatch(/\.jks|\.keystore|\.p8|\.p12/i);
      expect(raw).not.toMatch(/serviceAccountKeyPath/i);
      expect(raw).not.toMatch(/private[_-]?key/i);
      expect(raw).not.toMatch(/password|passwd/i);
      expect(raw).not.toMatch(/secret/i);
    }
  });

  test('release.yml stays source-only: no EAS build/submit, no store upload', () => {
    const workflow = readText('.github/workflows/release.yml');

    // Assert on store-upload mechanisms, not on disclaimer prose: the file
    // honestly names "no Play/App Store upload" in its own comments, and
    // that wording must not trip this guard.
    expect(workflow).not.toMatch(/eas\s+(build|submit)/);
    expect(workflow).not.toMatch(/service[_-]?account/i);
    expect(workflow).not.toMatch(/upload-to-play|upload_to_play/i);
    expect(workflow).not.toMatch(/androidpublisher/i);
    expect(workflow).toMatch(/[Ss]ource-only/);
  });
});
