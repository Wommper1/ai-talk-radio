import React from "react";

/* Small shared primitives, so every panel in the app looks like the same app. */

export function Panel({
  title,
  subtitle,
  right,
  children,
  className = "",
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-xl border border-[var(--color-line)] bg-[var(--color-panel)] texture ${className}`}>
      {(title || right) && (
        <header className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-5 py-3.5">
          <div>
            {title && (
              <h2 className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--color-dim)]">{title}</h2>
            )}
            {subtitle && <p className="mt-1 text-xs text-[var(--color-mute)]">{subtitle}</p>}
          </div>
          {right}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function Field({
  label,
  hint,
  children,
  className = "",
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  const id = React.useId();
  return (
    <div className={className}>
      <label
        htmlFor={id}
        className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.13em] text-[var(--color-dim)]"
      >
        {label}
      </label>
      {React.isValidElement(children)
        ? React.cloneElement(children as React.ReactElement<{ id?: string }>, { id })
        : children}
      {hint && <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-mute)]">{hint}</p>}
    </div>
  );
}

const controlBase =
  "w-full rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] px-3 py-2 text-sm " +
  "text-[#e8e8ee] placeholder:text-[var(--color-mute)] transition-colors " +
  "hover:border-[var(--color-line-bright)] focus:border-[var(--color-amber)] focus:outline-none " +
  "disabled:cursor-not-allowed disabled:opacity-50";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = "", ...props }, ref) {
    return <input ref={ref} className={`${controlBase} ${className}`} {...props} />;
  },
);

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(
  function Textarea({ className = "", ...props }, ref) {
    return <textarea ref={ref} className={`${controlBase} resize-y leading-relaxed ${className}`} {...props} />;
  },
);

export const Select = React.forwardRef<HTMLSelectElement, React.SelectHTMLAttributes<HTMLSelectElement>>(
  function Select({ className = "", children, ...props }, ref) {
    return (
      <select ref={ref} className={`${controlBase} cursor-pointer ${className}`} {...props}>
        {children}
      </select>
    );
  },
);

export function Button({
  type = "button",
  variant = "default",
  size = "md",
  className = "",
  children,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "default" | "primary" | "danger" | "ghost";
  size?: "sm" | "md";
}) {
  const variants = {
    default:
      "border border-[var(--color-line-bright)] bg-[var(--color-panel-2)] text-[#e8e8ee] hover:border-[var(--color-mute)] hover:bg-[#1e1e26]",
    primary:
      "border border-[var(--color-amber)] bg-[var(--color-amber)] text-[#1a1206] font-semibold hover:bg-[var(--color-amber-soft)] hover:border-[var(--color-amber-soft)]",
    danger:
      "border border-[#7f1d1d] bg-transparent text-[#fca5a5] hover:bg-[#7f1d1d]/25 hover:border-[#b91c1c]",
    ghost: "border border-transparent bg-transparent text-[var(--color-dim)] hover:text-white hover:bg-white/5",
  };
  const sizes = {
    sm: "px-2.5 py-1.5 text-xs gap-1.5",
    md: "px-4 py-2 text-sm gap-2",
  };

  return (
    <button
      type={type}
      className={`inline-flex items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${variants[variant]} ${sizes[size]} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  format,
  hint,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
  format?: (value: number) => string;
  hint?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <span className="text-[11px] font-semibold uppercase tracking-[0.13em] text-[var(--color-dim)]">{label}</span>
        <span className="font-mono text-xs tabular-nums text-[var(--color-amber)]">
          {format ? format(value) : value}
        </span>
      </div>
      <input
        type="range"
        className="w-full cursor-pointer"
        min={min}
        max={max}
        step={step}
        value={value}
        aria-label={label}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="mt-1.5 text-xs leading-relaxed text-[var(--color-mute)]">{hint}</p>}
    </div>
  );
}

export function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      onClick={() => onChange(!checked)}
      className="flex w-full items-start gap-3 rounded-lg border border-[var(--color-line)] bg-[var(--color-panel-2)] p-3 text-left transition-colors hover:border-[var(--color-line-bright)]"
    >
      <span
        className={`mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors ${
          checked ? "bg-[var(--color-amber)]" : "bg-[var(--color-line-bright)]"
        }`}
      >
        <span
          className={`h-4 w-4 rounded-full bg-white transition-transform ${checked ? "translate-x-4" : "translate-x-0"}`}
        />
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-[#e8e8ee]">{label}</span>
        {hint && <span className="mt-0.5 block text-xs leading-relaxed text-[var(--color-mute)]">{hint}</span>}
      </span>
    </button>
  );
}

export function StatusDot({ state }: { state: "ok" | "bad" | "unknown" | "busy" }) {
  const colors = {
    ok: "bg-[var(--color-good)]",
    bad: "bg-[var(--color-live)]",
    unknown: "bg-[var(--color-mute)]",
    busy: "bg-[var(--color-amber)] live-dot",
  };
  return <span className={`inline-block h-2 w-2 shrink-0 rounded-full ${colors[state]}`} />;
}

export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "error" | "good";
  title?: string;
  children: React.ReactNode;
}) {
  const tones = {
    info: "border-[var(--color-line-bright)] bg-[var(--color-panel-2)] text-[var(--color-dim)]",
    error: "border-[#7f1d1d] bg-[#7f1d1d]/15 text-[#fca5a5]",
    good: "border-[#166534] bg-[#166534]/15 text-[#86efac]",
  };
  return (
    <div className={`rounded-lg border px-3.5 py-3 text-sm leading-relaxed ${tones[tone]}`}>
      {title && <div className="mb-1 font-semibold">{title}</div>}
      {children}
    </div>
  );
}

/** Animated equaliser used as a "working" indicator. */
export function Equalizer({ active }: { active: boolean }) {
  return (
    <span className="inline-flex h-4 items-center gap-[3px]" aria-hidden="true">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className={`w-[3px] rounded-full bg-[var(--color-amber)] ${active ? "eq-bar" : ""}`}
          style={{ height: "100%", animationDelay: `${i * 0.13}s`, opacity: active ? 1 : 0.3 }}
        />
      ))}
    </span>
  );
}
