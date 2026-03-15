// Fire-and-forget emitter. Never throws, never blocks the worker.
// If MISSION_CONTROL_URL is not set, is a no-op.

import { env } from '../config/env.js';

export type MCEventType = "scan_start" | "scan_complete" | "wallet_found" | "scan_error" | "info" | "stats";

export interface MCEvent {
  id: string;       // crypto.randomUUID()
  type: MCEventType;
  wallet?: string;  // 0x address
  chain?: string;
  ts: number;       // Date.now()
  meta?: Record<string, unknown>;
}

export function emitStreamEvent(event: Omit<MCEvent, "id" | "ts">): void {
  if (!env.MISSION_CONTROL_URL) return;

  const fullEvent: MCEvent = {
    id: crypto.randomUUID(),
    ts: Date.now(),
    ...event,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (env.MISSION_CONTROL_SECRET) {
    headers['Authorization'] = `Bearer ${env.MISSION_CONTROL_SECRET}`;
  }

  fetch(env.MISSION_CONTROL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(fullEvent),
    signal: controller.signal,
  })
    .then(res => res.body?.cancel())
    .finally(() => clearTimeout(timeout))
    .catch(() => {});
}
