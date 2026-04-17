import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REMOTE = "origin";
const BRANCH = "main";
const PM2_PROCESS = "moonbags";
const GIT_TIMEOUT_MS = 30_000;
const NPM_TIMEOUT_MS = 120_000;
const PM2_TIMEOUT_MS = 20_000;

type CommandResult = {
  stdout: string;
  stderr: string;
};

export type UpdatePreview = {
  gitAvailable: boolean;
  currentSha: string;
  remoteSha: string;
  ahead: number;
  behind: number;
  dirtyFiles: string[];
  commits: string[];
  packageFilesChanged: boolean;
  pm2Available: boolean;
  pm2ProcessOnline: boolean;
};

export type PullUpdateResult = {
  previousSha: string;
  currentSha: string;
  packageFilesChanged: boolean;
  pullOutput: string;
  npmInstallOutput?: string;
};

export type UpdateBlockerCode =
  | "dirty_worktree"
  | "local_commits"
  | "up_to_date"
  | "pm2_missing"
  | "pm2_process_missing";

export type UpdateBlocker = {
  code: UpdateBlockerCode;
  title: string;
  detail: string;
  nextSteps: string[];
};

async function run(command: string, args: string[], timeout: number): Promise<CommandResult> {
  const { stdout, stderr } = await execFileAsync(command, args, { timeout });
  return { stdout: String(stdout).trim(), stderr: String(stderr).trim() };
}

async function git(args: string[], timeout = GIT_TIMEOUT_MS): Promise<string> {
  const { stdout } = await run("git", args, timeout);
  return stdout;
}

async function commandSucceeds(command: string, args: string[], timeout: number): Promise<boolean> {
  try {
    await run(command, args, timeout);
    return true;
  } catch {
    return false;
  }
}

function parseAheadBehind(raw: string): { ahead: number; behind: number } {
  const [aheadRaw, behindRaw] = raw.trim().split(/\s+/);
  return {
    ahead: Number.parseInt(aheadRaw ?? "0", 10) || 0,
    behind: Number.parseInt(behindRaw ?? "0", 10) || 0,
  };
}

function splitLines(raw: string): string[] {
  return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}

export async function getUpdatePreview(): Promise<UpdatePreview> {
  const gitAvailable = await commandSucceeds("git", ["--version"], GIT_TIMEOUT_MS);
  if (!gitAvailable) {
    throw new Error("git is not installed or not on PATH. Install git before using /update.");
  }

  await git(["fetch", REMOTE, BRANCH]);

  const currentSha = await git(["rev-parse", "--short", "HEAD"]);
  const remoteSha = await git(["rev-parse", "--short", `${REMOTE}/${BRANCH}`]);
  const counts = parseAheadBehind(await git(["rev-list", "--left-right", "--count", `HEAD...${REMOTE}/${BRANCH}`]));
  const dirtyFiles = splitLines(await git(["status", "--porcelain"]));
  const commits = splitLines(await git(["log", "--oneline", "--max-count=8", `HEAD..${REMOTE}/${BRANCH}`]));
  const changedFiles = splitLines(await git(["diff", "--name-only", `HEAD..${REMOTE}/${BRANCH}`]));
  const packageFilesChanged = changedFiles.some((file) =>
    file === "package.json" || file === "package-lock.json",
  );
  const pm2Available = await commandSucceeds("pm2", ["--version"], PM2_TIMEOUT_MS);
  const pm2ProcessOnline = pm2Available
    ? await commandSucceeds("pm2", ["describe", PM2_PROCESS], PM2_TIMEOUT_MS)
    : false;

  return {
    gitAvailable,
    currentSha,
    remoteSha,
    ahead: counts.ahead,
    behind: counts.behind,
    dirtyFiles,
    commits,
    packageFilesChanged,
    pm2Available,
    pm2ProcessOnline,
  };
}

export function getUpdateBlockerDetails(preview: UpdatePreview): UpdateBlocker | null {
  if (preview.dirtyFiles.length > 0) {
    return {
      code: "dirty_worktree",
      title: "Local file changes found",
      detail: `Working tree has ${preview.dirtyFiles.length} local change(s).`,
      nextSteps: [
        "Commit or stash local edits before updating.",
        "If this is a fresh install, ask support before deleting local files.",
      ],
    };
  }
  if (preview.ahead > 0) {
    return {
      code: "local_commits",
      title: "Local commits found",
      detail: `Local branch has ${preview.ahead} commit(s) not on ${REMOTE}/${BRANCH}.`,
      nextSteps: [
        "Push or merge local commits manually.",
        "Then rerun /update.",
      ],
    };
  }
  if (preview.behind === 0) {
    return {
      code: "up_to_date",
      title: "Already up to date",
      detail: "This bot already has the latest remote code.",
      nextSteps: [],
    };
  }
  if (!preview.pm2Available) {
    return {
      code: "pm2_missing",
      title: "PM2 is missing",
      detail: "pm2 is not installed or not on PATH.",
      nextSteps: [
        "npm install -g pm2",
        "pm2 start \"npm run start\" --name moonbags",
        "pm2 save",
      ],
    };
  }
  if (!preview.pm2ProcessOnline) {
    return {
      code: "pm2_process_missing",
      title: "MoonBags is not managed by PM2",
      detail: `pm2 process "${PM2_PROCESS}" was not found.`,
      nextSteps: [
        `PATH="$HOME/.local/bin:$PATH" pm2 start "npm run start" --name ${PM2_PROCESS}`,
        "pm2 save",
      ],
    };
  }
  return null;
}

export function getUpdateBlocker(preview: UpdatePreview): string | null {
  return getUpdateBlockerDetails(preview)?.detail ?? null;
}

export async function pullUpdate(preview: UpdatePreview): Promise<PullUpdateResult> {
  const blocker = getUpdateBlockerDetails(preview);
  if (blocker) throw new Error(blocker.detail);

  const previousSha = await git(["rev-parse", "--short", "HEAD"]);
  const pullOutput = await git(["pull", "--ff-only", REMOTE, BRANCH], 60_000);

  let npmInstallOutput: string | undefined;
  if (preview.packageFilesChanged) {
    const { stdout, stderr } = await run("npm", ["install"], NPM_TIMEOUT_MS);
    npmInstallOutput = [stdout, stderr].filter(Boolean).join("\n").trim();
  }

  const currentSha = await git(["rev-parse", "--short", "HEAD"]);
  return {
    previousSha,
    currentSha,
    packageFilesChanged: preview.packageFilesChanged,
    pullOutput,
    npmInstallOutput,
  };
}

export async function restartWithPm2(): Promise<void> {
  await run("pm2", ["restart", PM2_PROCESS, "--update-env"], PM2_TIMEOUT_MS);
}
