import {
  CalendarClock,
  MonitorUp,
  Network,
  ShieldCheck,
  ShieldOff,
  ShieldPlus,
  SlidersHorizontal,
} from 'lucide-react';

const CONTROL_ICONS = {
  warpKeeper: Network,
  zenGuard: ShieldCheck,
  desktopProxy: MonitorUp,
  firewall: ShieldOff,
  strictHosts: ShieldPlus,
  logonAutoStart: CalendarClock,
};

function getControlTag(control) {
  if (control.id === 'desktopProxy') {
    return control.enabled ? 'Wired :41987' : 'Unwired';
  }
  if (control.id === 'logonAutoStart') {
    return control.enabled ? 'Enabled' : 'Disabled';
  }
  return null;
}

export default function ProtectionPanel({ toggles, onToggle }) {
  const activeCount = toggles.filter((control) => control.enabled).length;

  return (
    <section className="panel protection-panel" aria-labelledby="protection-title">
      <header className="panel-heading">
        <div className="panel-heading__main">
          <span className="panel-heading__icon" aria-hidden="true">
            <SlidersHorizontal size={14} strokeWidth={1.9} />
          </span>
          <h2 className="panel-heading__title" id="protection-title">
            PROTECTION &amp; SERVICE CONTROLS
          </h2>
        </div>
        <span className="panel-heading__meta" aria-live="polite">
          <span className={`signal-dot ${activeCount > 0 ? 'is-live' : 'is-down'}`} aria-hidden="true" />
          {activeCount} OF 6 ACTIVE
        </span>
      </header>

      <div className="protection-list">
        {toggles.map((control) => {
          const Icon = CONTROL_ICONS[control.id] ?? ShieldCheck;
          const tag = getControlTag(control);
          const descriptionId = `${control.id}-description`;

          return (
            <div
              className={`control-row ${control.enabled ? 'is-on' : 'is-off'}`}
              key={control.id}
            >
              <span className="control-icon" aria-hidden="true">
                <Icon size={14.5} strokeWidth={1.8} />
              </span>

              <div className="control-copy">
                <div className="control-title-line">
                  <h3 className="control-title">{control.title}</h3>
                  {tag ? <span className="control-tag">{tag}</span> : null}
                </div>
                <p className="control-subtitle" id={descriptionId}>
                  {control.subtitle}
                </p>
              </div>

              <span className="control-state" aria-hidden="true">
                {control.enabled ? 'ON' : 'OFF'}
              </span>

              <button
                className={`switch ${control.enabled ? 'is-on' : ''}`}
                type="button"
                role="switch"
                aria-checked={control.enabled}
                aria-label={control.title}
                aria-describedby={descriptionId}
                onClick={() => onToggle(control.id)}
              >
                <span className="switch__thumb" aria-hidden="true" />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}
