import { initializeCoderProduct } from './coderProduct.js'
import { announceAilyCoderReadyProtocol } from './embedLifecycle.js'

// The owning application supplies an exact deployment directory. Query or
// fragment navigation cannot switch providers, roots, or document authority.
if (window.location.search || window.location.hash) {
  throw new TypeError('The Browser workbench requires its exact deployment URL.')
}

initializeCoderProduct()
announceAilyCoderReadyProtocol()
await import('./main.workbench.js')
