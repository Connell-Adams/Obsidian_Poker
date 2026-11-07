import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { OnlineContext, ServiceContext } from './app/context';
import { GameService } from './app/gameService';
import { OnlineService } from './online/onlineService';
import { App } from './ui/App';
import './ui/styles.css';

const root = createRoot(document.getElementById('root')!);

// Online services start alongside, but offline play never waits for them.
const online = new OnlineService();
void online.start();

GameService.create()
  .then((service) => {
    // Browsers only allow audio after a user gesture.
    const unlock = () => service.audio.unlock();
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    root.render(
      <StrictMode>
        <ServiceContext.Provider value={service}>
          <OnlineContext.Provider value={online}>
            <App />
          </OnlineContext.Provider>
        </ServiceContext.Provider>
      </StrictMode>,
    );
  })
  .catch((error: unknown) => {
    console.error(error);
    root.render(
      <div className="fatal">
        <h1>The room could not open</h1>
        <p>{error instanceof Error ? error.message : String(error)}</p>
      </div>,
    );
  });
