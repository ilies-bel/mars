import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import App from '@/app/App'
import { SseInvalidator } from '@/shared/SseInvalidator'
import { installDynamicImportRecovery } from '@/shared/dynamicImportRecovery'
import './styles/index.css'

// Guard against stale Vite dep-optimizer chunk 404s (e.g. highlighted-body-<hash>.js).
// Reloads once per session if a dynamic import fails so the user gets the fresh
// chunk instead of a broken FallbackBoundary. See mars-4ce23622.
installDynamicImportRecovery()

const root = document.getElementById('root')
if (!root) throw new Error('#root not found')

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
})

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <SseInvalidator />
      <App />
    </QueryClientProvider>
  </StrictMode>,
)
