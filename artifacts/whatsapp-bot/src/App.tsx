import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import {
  getGetWhatsappStatusQueryKey,
  useConnectWhatsapp,
  useGetWhatsappStatus,
  useToggleWhatsappBot,
} from '@workspace/api-client-react';
import { Check, CircleHelp, LoaderCircle, MessageCircle, Power, RefreshCw, ShieldCheck, Wifi } from 'lucide-react';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import {
  Route,
  Switch,
  useLocation,
  Router as WouterRouter,
} from 'wouter';

const queryClient = new QueryClient();

function Home() {
  const client = useQueryClient();
  const statusQuery = useGetWhatsappStatus({
    query: { queryKey: getGetWhatsappStatusQueryKey(), refetchInterval: 2000 },
  });
  const connect = useConnectWhatsapp({
    mutation: {
      onSuccess: () => client.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() }),
    },
  });
  const toggle = useToggleWhatsappBot({
    mutation: {
      onSuccess: () => client.invalidateQueries({ queryKey: getGetWhatsappStatusQueryKey() }),
    },
  });

  const status = statusQuery.data;
  const connectBusy = connect.isPending;
  const statusLabel: Record<string, string> = {
    idle: 'Sin conectar',
    connecting: 'Iniciando conexión',
    waiting_qr: 'Esperando lectura del código',
    connected: 'WhatsApp conectado',
    reconnecting: 'Restableciendo conexión',
    error: 'No se pudo conectar',
  };
  const connectionState = status?.connectionState ?? 'idle';
  const isConnected = Boolean(status?.connected && connectionState === 'connected');
  const isBusy = connectionState === 'connecting' || connectionState === 'reconnecting';

  const handleConnect = () => connect.mutate();
  const handleBotToggle = () => {
    if (status) toggle.mutate({ data: { enabled: !status.botEnabled } });
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand" aria-label="Nudo, panel de WhatsApp">
          <span className="brand-mark"><MessageCircle size={17} strokeWidth={2.2} /></span>
          <span>nudo<span className="brand-period">.</span></span>
        </div>
        <div className="topbar-note"><span className="tiny-dot" /> sesión de WhatsApp</div>
      </header>

      <section className="pairing-layout" aria-labelledby="page-title">
        <div className="intro">
          <div className="eyebrow"><span className="eyebrow-line" /> TU ASISTENTE, EN TU CHAT</div>
          <h1 id="page-title">Una conexión.<br /><em>Y ya está.</em></h1>
          <p className="intro-copy">Vincula tu WhatsApp personal y usa comandos para activar respuestas y mensajes de prueba en el chat que elijas.</p>
          <div className="privacy-note">
            <span className="privacy-icon"><ShieldCheck size={17} /></span>
            <span>Tu cuenta sigue siendo tuya.<br /><b>El bot solo responde cuando lo activas.</b></span>
          </div>
        </div>

        <div className="connection-card">
          <div className="card-heading">
            <div>
              <div className="card-kicker">CONEXIÓN DE WHATSAPP</div>
              <h2>{isConnected ? 'Todo en su sitio.' : 'Vincula tu cuenta'}</h2>
            </div>
            <div className={`connection-indicator ${isConnected ? 'is-online' : ''}`} aria-label={`Estado: ${statusLabel[connectionState]}`} data-testid="status-connection">
              <span className="indicator-dot" />
              <span>{statusLabel[connectionState]}</span>
            </div>
          </div>

          <div className="qr-stage">
            <div className="orbit orbit-one" />
            <div className="orbit orbit-two" />
            <div className="orbit orbit-three" />
            <div className="qr-frame">
              {statusQuery.isLoading ? (
                <div className="qr-placeholder" data-testid="status-loading" aria-label="Cargando estado de conexión">
                  <div className="skeleton-block" /><span className="skeleton-caption" />
                </div>
              ) : statusQuery.isError ? (
                <div className="qr-message qr-error" data-testid="status-query-error">
                  <CircleHelp size={25} />
                  <span>No pudimos consultar el estado.</span>
                  <button className="text-action" onClick={() => statusQuery.refetch()} data-testid="button-retry-status">Intentar de nuevo</button>
                </div>
              ) : isConnected ? (
                <div className="connected-mark" data-testid="status-connected">
                  <span className="success-ring"><Check size={35} strokeWidth={1.7} /></span>
                  <span className="connected-title">Conectado</span>
                  <span className="connected-caption">{status?.phoneNumber || 'Tu cuenta de WhatsApp está lista'}</span>
                </div>
              ) : status?.qrDataUrl ? (
                <img className="qr-image" src={status.qrDataUrl} alt="Código QR para vincular WhatsApp" data-testid="img-pairing-qr" />
              ) : (
                <div className="qr-message" data-testid={`status-${connectionState}`}>
                  {isBusy || connectionState === 'waiting_qr' ? (
                    <>
                      <LoaderCircle className="state-loader" size={28} />
                      <span>{connectionState === 'waiting_qr' ? 'Preparando tu código QR' : 'Abriendo una conexión segura'}</span>
                      <span className="qr-subcopy">{status?.statusMessage || 'Esto puede tardar unos segundos.'}</span>
                    </>
                  ) : connectionState === 'error' ? (
                    <>
                      <CircleHelp size={25} />
                      <span>{status?.statusMessage || 'La conexión necesita un nuevo intento.'}</span>
                    </>
                  ) : (
                    <>
                      <Wifi size={25} />
                      <span>El código aparecerá aquí</span>
                      <span className="qr-subcopy">Inicia la conexión para vincular tu teléfono.</span>
                    </>
                  )}
                </div>
              )}
            </div>
            <span className="orbit-caption">conexión cifrada</span>
          </div>

          {!isConnected ? (
            <div className="card-action">
              <button className="primary-button" onClick={handleConnect} disabled={connectBusy || isBusy} data-testid="button-connect-whatsapp" aria-label={connectionState === 'error' ? 'Reintentar conexión de WhatsApp' : 'Conectar WhatsApp'}>
                {connectBusy || isBusy ? <LoaderCircle size={17} className="button-spinner" /> : connectionState === 'error' ? <RefreshCw size={16} /> : <MessageCircle size={17} />}
                {connectBusy || isBusy ? 'Conectando…' : connectionState === 'error' ? 'Reintentar conexión' : status?.qrDataUrl ? 'Esperando que lo escanees' : 'Conectar WhatsApp'}
              </button>
              <div className="steps-copy">
                <span className="step-number">01</span>
                <span>Abre WhatsApp en tu teléfono</span>
                <span className="step-separator">·</span>
                <span className="step-number">02</span>
                <span>Dispositivos vinculados <span className="step-arrow">→</span> Vincular un dispositivo</span>
              </div>
              {(connect.isError || toggle.isError) && <p className="mutation-error" role="alert" data-testid="status-mutation-error">No se pudo completar la acción. Comprueba tu conexión e inténtalo de nuevo.</p>}
            </div>
          ) : (
            <div className="bot-control">
              <div className="bot-copy">
                <div className="bot-state-line"><span className={`bot-dot ${status?.botEnabled ? 'bot-active' : ''}`} /><span data-testid="status-bot">{status?.botEnabled ? 'Bot activo' : 'Bot pausado'}</span></div>
                <p>{status?.botEnabled ? 'Tu bot ya puede responder a tus comandos.' : 'Actívalo cuando quieras empezar a usar tus comandos.'}</p>
                <p className="bot-command-note" data-testid="text-command-help">Escribe <code>!spam</code> en un chat o grupo para enviar 5 mensajes de prueba, con 40 ms entre inicios y 60 s de espera.</p>
              </div>
              <button className={`bot-toggle ${status?.botEnabled ? 'toggle-on' : ''}`} onClick={handleBotToggle} disabled={toggle.isPending} role="switch" aria-checked={Boolean(status?.botEnabled)} aria-label={status?.botEnabled ? 'Pausar bot' : 'Activar bot'} data-testid="button-toggle-bot">
                <span className="toggle-knob">{toggle.isPending ? <LoaderCircle size={13} className="button-spinner" /> : <Power size={13} />}</span>
                <span>{toggle.isPending ? 'Guardando…' : status?.botEnabled ? 'Pausar bot' : 'Activar bot'}</span>
              </button>
              {toggle.isError && <p className="mutation-error" role="alert" data-testid="status-toggle-error">No se pudo cambiar el estado del bot. Vuelve a intentarlo.</p>}
            </div>
          )}
          {isConnected && status?.phoneNumber && <div className="account-line"><span className="account-check"><Check size={12} /></span> Cuenta vinculada <b>{status.phoneNumber}</b></div>}
        </div>
      </section>

      <footer className="page-footer">
        <span className="footer-mark">n.</span>
        <span>Hecho para mantenerlo simple.</span>
        <span className="footer-right"><span className="tiny-dot" /> No compartas este código QR</span>
      </footer>
    </main>
  );
}

function Router() {
  return (
    // Keep a shared shell (sidebar, navbar) outside the boundary so it
    // survives a page crash.
    <RoutedErrorBoundary>
      <Switch>
        <Route path="/" component={Home} />
        <Route component={NotFound} />
      </Switch>
    </RoutedErrorBoundary>
  );
}

function RoutedErrorBoundary({ children }: { children: ReactNode }) {
  const [location] = useLocation();
  return <ErrorBoundary resetKey={location}>{children}</ErrorBoundary>;
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
