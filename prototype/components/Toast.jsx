import { Check, Info, ShieldX, X } from 'lucide-react';

const TONE_ICONS = {
  success: Check,
  info: Info,
  warn: ShieldX,
};

export default function Toast({ toast, onDismiss }) {
  if (!toast) return null;

  const Icon = TONE_ICONS[toast.tone] ?? Info;

  return (
    <div className={`toast toast--${toast.tone}`}>
      <span className="toast__icon" aria-hidden="true">
        <Icon size={14} strokeWidth={2.1} />
      </span>
      <p className="toast__message" role="status" aria-live="polite">
        {toast.message}
      </p>
      <button
        className="toast__close"
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
      >
        <X size={12.5} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
