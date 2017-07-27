const {app, BrowserWindow} = require('electron')
const {ipcMain} = require('electron')
const http = require('http')
const textBody = require('body')
const uuid = require('uuid/v4')
const isNumeric = require('fast-isnumeric')

// const coerceCommon = require('./util/coerce-common')
// const isValidComponent = require('./util/is-valid-component')
const createIndex = require('./util/create-index')
const createTimer = require('./util/create-timer')

const BUFFER_OVERFLOW_LIMIT = 1e9
const REQUEST_TIMEOUT = 50000
const STATUS_MSG = {
  200: 'pong',
  401: 'error during request',
  499: 'client closed request before generation complete',
  404: 'invalid route',
  422: 'json parse error',
  522: 'client socket timeout'
}

/** Create
 *
 * @param {object} opts
 *   - component
 *   - port
 *   - ...
 *   - debug
 *
 *
 * @return {object} app
 */
function createApp (_opts) {
  const opts = coerceOpts(_opts)

  let server = null
  let win = null

  app.commandLine.appendSwitch('ignore-gpu-blacklist')

  app.on('ready', () => {
    win = new BrowserWindow(opts._browserWindowOpts)
    server = createServer(app, win, opts)

    if (opts.debug) {
      win.openDevTools()
    }

    win.on('closed', () => {
      server.close()
      win = null
    })

    process.on('exit', () => {
      server.close()
      if (win) {
        win.close()
      }
    })

    createIndex(opts, (pathToIndex) => {
      win.loadURL(`file://${pathToIndex}`)
    })

    win.webContents.once('did-finish-load', () => {
      server.listen(opts.port, () => {
        app.emit('after-connect', {
          port: opts.port
        })
      })
    })
  })

  return app
}

function coerceOpts (_opts) {
  const opts = {}

  opts.port = isNumeric(_opts.port) ? Number(_opts.port) : 8000
  opts.debug = !!_opts.debug

  opts._componentLookup = {
    'plotly-graph': require('./component/plotly-graph')
  }

  opts._browserWindowOpts = {}

  return opts
}

function createServer (app, win, opts) {
  let pending = 0

  return http.createServer((req, res) => {
    const timer = createTimer()
    const id = uuid()
    const route = req.url.substr(1)

    // initialize 'full' info object
    //   which accumulates parse, render, convert results
    //   and is emitted on 'export-error' and 'after-convert'
    const fullInfo = {
      port: opts.port
    }

    const simpleReply = (code, msg) => {
      res.writeHead(code, {'Content-Type': 'text/plain'})
      return res.end(msg || STATUS_MSG[code])
    }

    const errorReply = (code) => {
      fullInfo.msg = fullInfo.msg || STATUS_MSG[code] || ''

      app.emit('export-error', Object.assign(
        {code: code},
        fullInfo
      ))

      return simpleReply(code, fullInfo.msg)
    }

    req.once('error', () => simpleReply(401))
    req.once('close', () => simpleReply(499))

    req.socket.removeAllListeners('timeout')
    req.socket.on('timeout', () => simpleReply(522))
    req.socket.setTimeout(REQUEST_TIMEOUT)

    if (route === 'ping') {
      return simpleReply(200)
    }

    const comp = opts._componentLookup[route]

    if (!comp) {
      return errorReply(404)
    }

    // setup parse callback
    const sendToRenderer = (errorCode, parseInfo) => {
      Object.assign(fullInfo, parseInfo)

      if (errorCode) {
        return errorReply(errorCode)
      }

      win.webContents.send(comp.name, id, fullInfo, opts)
    }

    // setup convert callback
    const reply = (errorCode, convertInfo) => {
      Object.assign(fullInfo, convertInfo)

      if (errorCode) {
        return errorReply(errorCode)
      }

      fullInfo.pending = --pending
      fullInfo.processingTime = timer.end()

      const cb = () => {
        app.emit('after-convert', fullInfo)
      }

      res.writeHead(200, fullInfo.head)

      if (res.write(fullInfo.body)) {
        res.end(cb)
      } else {
        res.once('drain', () => res.end(cb))
      }
    }

    // parse -> send to renderer!
    textBody(req, {limit: BUFFER_OVERFLOW_LIMIT}, (err, _body) => {
      let body

      if (err) {
        return errorReply(422)
      }

      try {
        body = JSON.parse(_body)
      } catch (e) {
        return errorReply(422)
      }

      pending++
      comp.parse(body, opts, sendToRenderer)
    })

    // convert on render message -> end response
    ipcMain.once(id, (event, errorCode, renderInfo) => {
      Object.assign(fullInfo, renderInfo)

      if (errorCode) {
        return errorReply(errorCode)
      }

      comp.convert(fullInfo, opts, reply)
    })
  })
}

module.exports = createApp
