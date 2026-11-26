/*
 * Sernicord UI kit — shared building blocks for every Sernicord panel and modal, so they all
 * look like Szmelc HQ instead of each plugin hand-rolling inline styles. The stylesheet is
 * enabled on first render and stays on (it only defines vc-sx-* classes and --sx-* tokens).
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { enableStyle } from "@api/Styles";
import { Switch } from "@components/Switch";
import { React } from "@webpack/common";

import kitStyle from "./kit.css?managed";

export function ensureKit() {
    try { enableStyle(kitStyle); } catch { /* style map not ready: next render retries */ }
}

export const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");

type Kids = { children?: React.ReactNode; };

/** Root container: enables the kit stylesheet and sets base colour, font size and spacing. */
export function Sx({ children, pad, className, style }: Kids & { pad?: boolean; className?: string; style?: React.CSSProperties; }) {
    ensureKit();
    return <div className={cx("vc-sx", pad && "vc-sx-pad", className)} style={style}>{children}</div>;
}

export type Tone = "grey" | "accent" | "danger" | "aqua" | "outline";

export function Pill({ children, tone = "grey", title }: Kids & { tone?: Tone; title?: string; }) {
    ensureKit();
    return <span className={cx("vc-sx-pill", tone !== "grey" && tone)} title={title}>{children}</span>;
}

/** Tab strip (role=tablist). `inline` renders a compact segmented control for filters. */
export function Tabs<T extends string>({ value, onChange, tabs, inline, label }: {
    value: T;
    onChange(v: T): void;
    tabs: Array<[NoInfer<T>, string, number?]>;
    inline?: boolean;
    label?: string;
}) {
    ensureKit();
    return (
        <div className={cx("vc-sx-tabs", inline && "inline")} role="tablist" aria-label={label}>
            {tabs.map(([id, text, count]) => (
                <button
                    key={id}
                    type="button"
                    role="tab"
                    className="vc-sx-tab"
                    aria-selected={value === id}
                    onClick={() => onChange(id)}
                >
                    {text}{count != null && <span className="n">{count}</span>}
                </button>
            ))}
        </div>
    );
}

/** Checkbox with a full-width clickable label. */
export function Check({ checked, onChange, disabled, title, children }: Kids & {
    checked: boolean;
    onChange(v: boolean): void;
    disabled?: boolean;
    title?: string;
}) {
    ensureKit();
    return (
        <label className={cx("vc-sx-check", disabled && "disabled")} title={title}>
            <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.currentTarget.checked)} />
            <span className="vc-sx-grow">{children}</span>
        </label>
    );
}

/** Discord Switch with a label next to it. */
export function Toggle({ checked, onChange, children }: Kids & { checked: boolean; onChange(v: boolean): void; }) {
    ensureKit();
    return (
        <span className="vc-sx-toggle">
            <Switch checked={checked} onChange={onChange} />
            <span>{children}</span>
        </span>
    );
}

export function Code({ text, max = 320 }: { text: string; max?: number; }) {
    ensureKit();
    return <pre className="vc-sx-code" style={{ maxHeight: max }}>{text || "(empty)"}</pre>;
}

export function Empty({ children }: Kids) {
    ensureKit();
    return <div className="vc-sx-empty">{children}</div>;
}
