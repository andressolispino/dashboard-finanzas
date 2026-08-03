import { Component, StrictMode, type ErrorInfo, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'

class DashboardErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error: Error, details: ErrorInfo) {
    console.error('El dashboard no pudo mostrar los datos.', error, details)
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="fatal-error-shell">
          <section className="fatal-error-card" role="alert">
            <span>Finanzas personales</span>
            <h1>No pudimos mostrar los datos</h1>
            <p>
              La hoja contiene un valor que el dashboard no pudo interpretar.
              Recarga la página para volver a intentarlo.
            </p>
            <button type="button" onClick={() => window.location.reload()}>
              Recargar dashboard
            </button>
          </section>
        </main>
      )
    }
    return this.props.children
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <DashboardErrorBoundary>
      <App />
    </DashboardErrorBoundary>
  </StrictMode>,
)
