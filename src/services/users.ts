/**
 * Account lifecycle: register, login, profile updates, role assignment from
 * env config, avatar handling. All inputs sanitized before persistence.
 */
import { config } from "../config.js";
import { appLog } from "../logger.js";
import { SERVICE_ACTOR_HANDLE } from "../fediverse/remote.js";
import { store } from "../store.js";
import type { Role, UserRecord } from "../types.js";
import { HANDLE_RE, escapeHtml, hashPassword, isoNow, newId, verifyPassword } from "../util.js";
import { sanitizeHexColor, sanitizePlain, sanitizeProfileCss, sanitizeTextHtml } from "../security/sanitize.js";

const log = appLog("users");

export interface RegisterResult {
  ok: boolean;
  error?: string;
  user?: UserRecord;
}

export async function registerUser(input: {
  handle: string;
  displayName: string;
  email: string;
  password: string;
}): Promise<RegisterResult> {
  const handle = input.handle.trim().toLowerCase();
  if (!HANDLE_RE.test(handle)) {
    return {
      ok: false,
      error: "Handle must be 3-20 characters: lowercase letters, numbers, underscores.",
    };
  }
  if (handle === SERVICE_ACTOR_HANDLE) {
    return { ok: false, error: "That handle is reserved." };
  }
  if (await store.handleExists(handle)) {
    return { ok: false, error: "That handle is already taken." };
  }
  const displayName = sanitizePlain(input.displayName).slice(0, 50) || handle;
  const email = input.email.trim();
  if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { ok: false, error: "That email address doesn't look right." };
  }
  if (email !== "" && (await store.getUserByEmail(email))) {
    return { ok: false, error: "That email is already registered." };
  }
  if (input.password.length < 8) {
    return { ok: false, error: "Password must be at least 8 characters." };
  }
  if (input.password.length > 128) {
    return { ok: false, error: "Password must be at most 128 characters." };
  }

  let role: Role = "user";
  if (config.adminHandles.includes(handle)) role = "admin";
  else if (config.moderatorHandles.includes(handle)) role = "moderator";

  const user: UserRecord = {
    id: newId(),
    handle,
    displayName,
    email: email === "" ? null : email.toLowerCase(),
    passwordHash: await hashPassword(input.password),
    role,
    suspended: false,
    suspendReason: null,
    bioHtml: "",
    avatar: null,
    themeColor: "",
    customCss: "",
    createdAt: isoNow(),
    lastLogin: null,
  };
  await store.createUser(user);
  log.info`Registered new user ${handle} (role: ${role})`;
  return { ok: true, user };
}

export interface LoginResult {
  ok: boolean;
  error?: string;
  user?: UserRecord;
}

export async function authenticate(handle: string, password: string): Promise<LoginResult> {
  const user = await store.getUser(handle.trim().toLowerCase());
  if (!user) {
    // Equal-time dummy verify to blunt username enumeration timing.
    await hashPassword(password);
    return { ok: false, error: "Wrong username or password." };
  }
  const valid = await verifyPassword(password, user.passwordHash);
  if (!valid) return { ok: false, error: "Wrong username or password." };
  if (user.suspended) {
    return {
      ok: false,
      error: `This account is suspended. ${user.suspendReason ? "Reason: " + user.suspendReason : ""}`.trim(),
    };
  }
  // Promote env-configured admins/mods on login if their role changed.
  const configuredRole: Role = config.adminHandles.includes(user.handle)
    ? "admin"
    : config.moderatorHandles.includes(user.handle)
      ? "moderator"
      : "user";
  if (configuredRole !== "user" && configuredRole !== user.role) {
    await store.updateUser(user.handle, { role: configuredRole });
    user.role = configuredRole;
  }
  await store.updateUser(user.handle, { lastLogin: isoNow() });
  return { ok: true, user };
}

export interface ProfileUpdateInput {
  displayName: string;
  bioRaw: string;
  themeColor: string;
  customCss: string;
}

export async function updateProfile(
  handle: string,
  input: ProfileUpdateInput,
): Promise<{ ok: boolean; error?: string }> {
  const displayName = sanitizePlain(input.displayName).slice(0, 50);
  if (displayName === "") return { ok: false, error: "Display name can't be empty." };
  const bioHtml = sanitizeTextHtml(input.bioRaw.replace(/\r\n/g, "\n").replace(/\n/g, "<br>"));
  const themeColor = sanitizeHexColor(input.themeColor);
  const customCss = sanitizeProfileCss(input.customCss);
  const updated = await store.updateUser(handle, { displayName, bioHtml, themeColor, customCss });
  if (!updated) return { ok: false, error: "User not found." };
  log.debug`Profile updated for ${handle}`;
  return { ok: true };
}

export async function setAvatar(handle: string, filename: string | null): Promise<void> {
  await store.updateUser(handle, { avatar: filename });
}

export async function changePassword(
  handle: string,
  currentPassword: string,
  newPassword: string,
): Promise<{ ok: boolean; error?: string }> {
  const user = await store.getUser(handle);
  if (!user) return { ok: false, error: "User not found." };
  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    return { ok: false, error: "Current password is incorrect." };
  }
  if (newPassword.length < 8 || newPassword.length > 128) {
    return { ok: false, error: "New password must be 8-128 characters." };
  }
  await store.updateUser(handle, { passwordHash: await hashPassword(newPassword) });
  log.info`Password changed for ${handle}`;
  return { ok: true };
}

export function publicUserView(u: UserRecord): {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  bioHtml: string;
  role: Role;
  createdAt: string;
  friendCount: number;
} {
  return {
    handle: u.handle,
    displayName: escapeHtml(u.displayName),
    avatarUrl: u.avatar ? `/media/${u.avatar}` : null,
    bioHtml: u.bioHtml,
    role: u.role,
    createdAt: u.createdAt,
    friendCount: 0,
  };
}