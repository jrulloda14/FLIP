import { DotMeter, DotPlot } from '../components/primitives';
import { Sheet } from '../components/controls';
import { normalizeHistory } from '../components/SystemMonitor';
import { gb, pct, rate, temp, uptime } from '../lib/format';
import { useFlip } from '../lib/store';

export function SystemDetail() {
  const { state, actions } = useFlip();
  const sys = state.system;
  const s = state.settings!;
  const close = () => actions.openOverlay(null);
  const closeBtn = (
    <button className="fl-ctl" onClick={close}>
      ESC CLOSE
    </button>
  );
  if (!sys) {
    return (
      <Sheet label="System" title="SYSTEM" right={closeBtn}>
        <div className="fl-detail fl-ink3">WAITING FOR FIRST SAMPLE</div>
      </Sheet>
    );
  }
  const unit = s.system.tempUnit;
  const NA = ({ v }: { v: string }) => <span className={v === 'N/A' ? 'fl-ink3' : undefined}>{v}</span>;
  return (
    <Sheet
      label="System monitor detail"
      className="fl-ov--sys"
      title={`SYSTEM · ${sys.hostname}`}
      right={closeBtn}
      footer={
        <>
          <span className="grow" />
          <span className="fl-ink3 fl-small">
            SAMPLING EVERY {s.system.sampleSeconds}S · {uptime(sys.uptimeSecs)} · {sys.processCount} PROCS
          </span>
          <button className="fl-btn fl-btn--primary" onClick={close}>
            CLOSE <kbd>ESC</kbd>
          </button>
        </>
      }
    >
      <div className="fl-two">
        <div>
          <div className="fl-detail">
            <div className="fl-sec fl-sec--flat">
              <span>
                CPU · {sys.cpu.threads} THREADS
              </span>
              <span>{pct(sys.cpu.usage)}</span>
            </div>
            <div className="fl-ink3 fl-small">{sys.cpu.name.toUpperCase()}</div>
            <DotPlot values={sys.cpuHistory} rows={10} pitch={9} />
          </div>
          <div className="fl-cores">
            {sys.cpu.perCore.map((v, i) => (
              <div className="fl-core" key={i}>
                <span>CORE {String(i).padStart(2, '0')}</span>
                <DotMeter value={v} cells={20} />
                <span className="r">{pct(v)}</span>
              </div>
            ))}
          </div>
          <div className="fl-kv">
            <span>CPU TEMP</span>
            <NA v={temp(sys.cpu.temperatureC, unit)} />
          </div>
          <div className="fl-detail">
            <div className="fl-sec fl-sec--flat">
              <span>NETWORK · ALL ADAPTERS</span>
              <span>
                ↓ {rate(sys.network.rxBytesPerSec)} · ↑ {rate(sys.network.txBytesPerSec)}
              </span>
            </div>
            <DotPlot values={normalizeHistory(sys.rxHistory)} rows={5} pitch={8} />
            <DotPlot values={normalizeHistory(sys.txHistory)} rows={3} pitch={8} />
            <div className="fl-ink3 fl-small">DOWNLOAD (TOP) · UPLOAD (BOTTOM) · LAST 60 SAMPLES, SCALED TO PEAK</div>
          </div>
        </div>
        <div>
          <div className="fl-kv">
            <span>MEMORY</span>
            <span>
              {gb(sys.memory.usedBytes)} / {gb(sys.memory.totalBytes)} GB · {pct(sys.memory.totalBytes ? sys.memory.usedBytes / sys.memory.totalBytes : null)}
            </span>
          </div>
          <div className="fl-kv">
            <span>GPU</span>
            <span>{sys.gpu.name?.toUpperCase() ?? 'N/A'}</span>
          </div>
          <div className="fl-kv">
            <span>GPU LOAD · TEMP</span>
            <span>
              <NA v={pct(sys.gpu.usage)} /> · <NA v={temp(sys.gpu.temperatureC, unit)} />
            </span>
          </div>
          {sys.disks.map((d) => (
            <div className="fl-kv" key={d.mount}>
              <span>DISK {d.mount}</span>
              <span>
                {gb(d.usedBytes, 0)} / {gb(d.totalBytes, 0)} GB · {pct(d.totalBytes ? d.usedBytes / d.totalBytes : null)}
              </span>
            </div>
          ))}
          <div className="fl-ptab">
            <div className="fl-board__r fl-board__h">
              <span>PROCESS</span>
              <span className="r">CPU</span>
              <span className="r">MEMORY</span>
            </div>
            {sys.topProcesses.map((p, i) => (
              <div className="fl-board__r" key={p.name + i}>
                <span>{p.name}</span>
                <span className="r">{(p.cpu * 100).toFixed(1)}%</span>
                <span className="r">{gb(p.memoryBytes, 2)} GB</span>
              </div>
            ))}
          </div>
          {sys.limitations.length > 0 && (
            <div className="fl-detail">
              <div className="fl-sec fl-sec--flat">
                <span>LIMITATIONS</span>
                <span>WHY SOME VALUES ARE N/A</span>
              </div>
              {sys.limitations.map((l) => (
                <div className="fl-limit" key={l.metric}>
                  <span>{l.metric}</span>
                  <span className="fl-case">{l.reason}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Sheet>
  );
}
