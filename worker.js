import { outgoingHandler } from '@bytecodealliance/preview2-shim/http'
import { home } from './terminal-text.js'

// Derived from the terminal prototype; returns cwd and supports completion metadata.
// The demo provides no network capability, including for otherwise public URLs.
outgoingHandler.handle = () => {
  throw { tag: 'HTTP-request-denied' }
}

const seed = `
mkdir -p ${home}/workspace
cd ${home}/workspace
cat > app.log <<'EOF'
09:00:01 INFO  worker started
09:00:02 INFO  processing batch 1
09:00:03 ERROR request timed out
09:00:04 INFO  retry succeeded
09:00:05 ERROR missing customer id
09:00:06 INFO  batch complete
09:00:07 ERROR upload failed
EOF
cat > projects.json <<'EOF'
[
  {"name": "Strands Shell", "language": "Rust", "stars": 42},
  {"name": "Paper Plane", "language": "Python", "stars": 17},
  {"name": "Little Planet", "language": "TypeScript", "stars": 28}
]
EOF
cat > words.txt <<'EOF'
pear
apple
pear
orange
apple
banana
EOF
cat > README.txt <<'EOF'
Welcome to your in-memory workspace.

app.log        Sample application logs
projects.json  Fictional project data for jq
words.txt      A small list to sort and count

Try pipelines, loops, variables, file redirection, and Lua.
Files live for this session. Reset or reload to start fresh.
Network access is disabled. This is not a host OS or a package manager.
EOF
`

try {
  const { execute } = await import('./generated/shell.js')
  const result = await execute(seed)
  if (result.status !== 0 || result.stderr) {
    throw new Error(`Could not prepare the workspace: ${result.stderr}`)
  }
  self.onmessage = async ({ data }) => {
    try {
      const started = performance.now()
      const output = await execute(data.command)
      self.postMessage({ type: 'result', id: data.id, ...output, elapsed: performance.now() - started })
    } catch (error) {
      self.postMessage({ type: 'fatal', message: error.message || String(error) })
    }
  }
  self.postMessage({ type: 'ready', cwd: result.cwd, files: result.files })
} catch (error) {
  self.postMessage({ type: 'fatal', message: error.message || String(error) })
}
