import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ServiceContext } from './app/context';
import { GameService } from './app/gameService';
import { App } from './ui/App';
import './ui/styles.css';

const root = createRoot(document.getElementById('root')!);

GameService.create()
  .then((service) => {
    // Browsers only allow audio after a user gesture.
    const unlock = () => service.audio.unlock();
    window.addEventListener('pointerdown', unlock, { passive: true });
    window.addEventListener('keydown', unlock);
    root.render(
      <StrictMode>
        <ServiceContext.Provider value={service}>
          <App />
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
