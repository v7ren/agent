export type DeliveryReason = 'ok' | 'permissions' | 'rate-limit' | 'network' | 'too-long' | 'unknown';

export type Delivery = { at: string; ok: boolean; reason: DeliveryReason; segments: number };

const STALE_MS = 12 * 3_600_000;

// Only the reason is kept; the raw error text is read here and never stored or rendered.
export function classifyError(err: unknown): DeliveryReason {
  const haystack = `${codeText(err)} ${messageText(err)}`.toLowerCase();
  if (/50013|50001|missing permissions|missing access/.test(haystack)) return 'permissions';
  if (/\b429\b|rate limit/.test(haystack)) return 'rate-limit';
  if (/econnreset|etimedout|enotfound|fetch failed|timeout/.test(haystack)) return 'network';
  if (/50035|must be 2000 or fewer/.test(haystack)) return 'too-long';
  return 'unknown';
}

export function recordDelivery(ok: boolean, now: Date, err?: unknown, segments = 1): Delivery {
  return {
    at: now.toISOString(),
    ok,
    reason: ok ? 'ok' : classifyError(err),
    segments,
  };
}

export function renderDelivery(d: Delivery | null, now: Date, heardSince: boolean): string {
  if (d === null) return '';
  const sentAt = new Date(d.at);
  if (Number.isNaN(sentAt.getTime())) return '';
  if (now.getTime() - sentAt.getTime() > STALE_MS) return '';

  const clock = `${pad(sentAt.getHours())}:${pad(sentAt.getMinutes())}`;
  if (d.ok && d.reason === 'ok') {
    const after = heardSince ? '他之後有回了' : '他之後還沒回';
    return `（你上一句話在 ${clock} 已經送到聊天裡了；${after}。）`;
  }
  return `（你上一句話沒有送出去：${explainFailure(d.reason)}。他可能根本沒看到，不要當作他已經知道。）`;
}

function explainFailure(reason: DeliveryReason): string {
  switch (reason) {
    case 'permissions':
      return '沒有發言權限';
    case 'rate-limit':
      return '被限流';
    case 'network':
      return '網路出問題';
    case 'too-long':
      return '太長';
    default:
      return '原因不明';
  }
}

function codeText(err: unknown): string {
  if (typeof err === 'number' || typeof err === 'string') return typeof err === 'number' ? String(err) : '';
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string' || typeof code === 'number') return String(code);
  }
  return '';
}

function messageText(err: unknown): string {
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null && 'message' in err) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return '';
}

function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
