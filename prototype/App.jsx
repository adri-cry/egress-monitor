import { useEffect } from 'react';
import ActionBar from './components/ActionBar';
import Header from './components/Header';
import LogViewer from './components/LogViewer';
import ProtectionPanel from './components/ProtectionPanel';
import StatusCards from './components/StatusCards';
import Titlebar from './components/Titlebar';
import Toast from './components/Toast';
import { useControlDeck } from './hooks/useControlDeck';

export default function App() {
  const deck = useControlDeck();
  const {
    snapshot,
    toggles,
    logs,
    activeTab,
    toast,
    setActiveTab,
    rotateNow,
    toggleControl,
    setEdgePolicy,
    reRollEdge,
    launchClient,
    toggleConnection,
    refresh,
    copyActiveLog,
    dismissToast,
  } = deck;

  useEffect(() => {
    const handleKeyDown = (event) => {
      if (
        !event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.key.toLowerCase() !== 'r'
      ) {
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, [contenteditable="true"]')
      ) {
        return;
      }

      event.preventDefault();
      rotateNow();
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [rotateNow]);

  return (
    <div className="app">
      <a className="skip-link" href="#main-content">
        Skip to control deck
      </a>

      <Titlebar />

      <div className="app__scroller">
        <main className="app__main" id="main-content">
          <Header connected={snapshot.connected} onRefresh={refresh} />

          <ActionBar
            connected={snapshot.connected}
            onLaunchDesktop={() => launchClient('desktop')}
            onLaunchCli={() => launchClient('cli')}
            onRotate={rotateNow}
            onToggleConnection={toggleConnection}
          />

          <StatusCards
            snapshot={snapshot}
            connected={snapshot.connected}
            onEdgeSelect={setEdgePolicy}
            onReRollEdge={reRollEdge}
          />

          <div className="workspace">
            <ProtectionPanel toggles={toggles} onToggle={toggleControl} />

            <LogViewer
              logs={logs}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              onCopy={copyActiveLog}
            />
          </div>

          <footer className="app-footer">
            <div className="app-footer__lane">
              <span className="app-footer__mark" aria-hidden="true">
                OCU
              </span>
              <span>FAIL-CLOSED WINDOWS LANE</span>
              <span className="app-footer__separator" aria-hidden="true">
                /
              </span>
              <span className={snapshot.connected ? 'app-footer__online' : 'app-footer__offline'}>
                {snapshot.connected ? 'TUNNEL ACTIVE' : 'TUNNEL OFFLINE'}
              </span>
            </div>
            <p className="app-footer__note">
              Demo control plane — WARP, firewall &amp; launch actions are simulated locally.
            </p>
          </footer>
        </main>
      </div>

      {toast ? <Toast key={toast.id} toast={toast} onDismiss={dismissToast} /> : null}
    </div>
  );
}
