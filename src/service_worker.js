import '../lib/JSZip.js' // ZIP library
import '../lib/he.js' // Decode HTML entities

const REDIRECT_URL = 'https://idp.polito.it/idp/profile/SAML2/Redirect/SSO'
const DIDA = {
   code: 'MATDID',
   url: 'https://didattica.polito.it/pls/portal30/sviluppo.filemgr.handler',
}
const DROP = {
   code: 'MATDROPBOX',
   url: 'https://didattica.polito.it/pls/portal30/sviluppo.filemgr_dropbox_1.handler',
}

/**
 * Module containing variables
 */
const ServiceWorkerState = (function () {
   const pub = {}
   const ZIP = {
      blob: undefined,
      name: undefined,
   }
   const CONN = {
      code: undefined,
      url: undefined,
   }
   const TAB = {
      id: undefined,
   }
   const FILE_STATS = {
      count: 0,
      downloaded: 0,
   }

   pub.getZip = () => {
      return ZIP
   }

   pub.setZip = (blob, name) => {
      ZIP.blob = blob
      ZIP.name = name
   }

   pub.getConn = () => {
      return CONN
   }

   pub.setConn = (code, url) => {
      CONN.code = code
      CONN.url = url
   }

   pub.getTab = () => {
      return TAB
   }

   pub.setTab = (id) => {
      TAB.id = id
   }

   pub.getFileStats = () => {
      return FILE_STATS
   }

   pub.setFileStats = (count, downloaded) => {
      FILE_STATS.count = count
      FILE_STATS.downloaded = downloaded
   }

   pub.incrementFileStats = (count, downloaded) => {
      FILE_STATS.count += count
      FILE_STATS.downloaded += downloaded
   }

   return pub
})()

/**
 * Listen for messages sent by ./content_script.js and generate the ZIP
 */
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
   generateZip(request.dirCode, request.dirName, sender.tab.id)
      .then((msg) => sendResponse({ data: { ok: true, msg } }))
      .catch((msg) => sendResponse({ data: { ok: false, msg } }))
   return true
})

/**
 * Reload the Service Worker when navigating (or refreshing) to pages with
 * matching URL
 */
chrome.webNavigation.onBeforeNavigate.addListener(
   function (details) {
      chrome.runtime.reload()
   },
   { url: [{ hostContains: 'didattica.polito.it', pathContains: 'pagina_corso' }] }
)

/**
 * Listen for messages sent by src/pages/download.js and respond with the generated ZIP
 */
self.onmessage = (e) => {
   const { cmd, args } = e.data
   if (cmd === 'getZipBlob') {
      const { blob, name } = ServiceWorkerState.getZip()
      if (blob && name) {
         blob.arrayBuffer().then((buf) => e.source.postMessage({ blob, name }, [buf]))
      }
   }
}

/**
 * Generate the zip relative to the selected folder
 */
const generateZip = (dirCode, dirName, tabId) => {
   ServiceWorkerState.setTab(tabId)
   ServiceWorkerState.setZip(undefined, undefined)
   ServiceWorkerState.setConn(undefined, undefined)
   ServiceWorkerState.setFileStats(0, 0)
   return new Promise(async (resolve, reject) => {
      try {
         await setConnectionType(dirCode)
         await checkCredentials(dirCode)
         const zip = new JSZip()
         await countFiles(dirCode, 'dir', 0)
         updateUI('size', ServiceWorkerState.getFileStats().count)
         await downloadFiles(dirCode, dirName, zip, 'dir', 0)

         updateUI('zip')
         ServiceWorkerState.setZip(
            await zip.generateAsync({
               type: 'blob',
            }),
            dirName
         )
         chrome.tabs.create({ url: 'src/pages/download.html', active: false }, (tab) => {
            updateUI('perc', ServiceWorkerState.getFileStats().downloaded)
            return resolve('SUCCESS! :)')
         })
      } catch (e) {
         updateUI('perc', 0)
         return reject(e)
      }
   })
}

/**
 * Test DIDA.url and see if it's successfull
 * if DIDA returned a non empty list then conn = DIDA
 */
const setConnectionType = () => {
   return new Promise(async (resolve, reject) => {
      const response = await fetchUrl(DIDA.url, '')
      if (response.ok) {
         const list = await response.json()
         const conn = list.result.length != 0 ? DIDA : DROP
         ServiceWorkerState.setConn(conn.code, conn.url)
         return resolve(true)
      } else {
         return reject('CAN NOT DETERMINE CONNECTION TYPE')
      }
   })
}

/**
 * Function that recursively downloads the elements of a directory
 */
const downloadFiles = (code, name, parent, type, size) => {
   const conn = ServiceWorkerState.getConn()
   return new Promise(async (resolve, reject) => {
      if (type == 'file') {
         const response = await fetch(
            `https://file.didattica.polito.it/download/${conn.code}/${code}?download`,
            {
               method: 'GET',
               credentials: 'same-origin',
            }
         )

         if (response.ok) {
            const blob = await response.blob()
            parent.file(name, blob, { binary: true })
            ServiceWorkerState.incrementFileStats(0, size)
            updateUI('perc', ServiceWorkerState.getFileStats().downloaded)
            return resolve(true)
         }

         return reject(`ERROR IN DOWNLOADING FILE "${name}" (status: ${response.status})`)
      }
      if (type == 'dir') {
         const folder = parent.folder(name)
         const response = await fetchUrl(conn.url, code)
         if (response.ok) {
            try {
               const list = await response.json()
               await Promise.all(
                  list.result.map(async (item) => {
                     if (!item.link) {
                        await downloadFiles(item.code, item.name, folder, item.type, item.size)
                     }
                  })
               )
               return resolve(true)
            } catch (e) {
               return reject(e)
            }
         }
         return reject(`ERROR IN FETCHING DIR "${name}" (status: ${response.status})`)
      }
   })
}

/**
 * Check if credentials are correctly setted
 * If not, set them through a "fake" login using RelayState and SAMLResponse
 * returned by the redirected loginResponse
 */
const checkCredentials = async (dirCode) => {
   const conn = ServiceWorkerState.getConn()
   return new Promise(async (resolve, reject) => {
      const testResponse = await fetchUrl(conn.url, dirCode)
      if (testResponse.ok) {
         const testItem = (await testResponse.json()).result[0]
         if (testItem) {
            const loginResponse = await fetch(
               `https://file.didattica.polito.it/download/${conn.code}/${testItem.code}?download`,
               {
                  method: 'GET',
                  credentials: 'same-origin',
               }
            )
            if (loginResponse.redirected && loginResponse.url === REDIRECT_URL) {
               const text = (await loginResponse.text()).replace(/\s+/g, '').replace(/\n+/g, '')
               const action = he.decode(text.match(/(?<=\<formaction\=\").*?(?=\")/gs)[0])
               const RelayState = he.decode(
                  text.match(/(?<=name\=\"RelayState\"value\=\").*?(?=\")/gs)[0]
               )
               const SAMLResponse = he.decode(
                  text.match(/(?<=name\=\"SAMLResponse\"value\=\").*?(?=\")/gs)[0]
               )
               const redirect = await fetch(action, {
                  method: 'POST',
                  body: `RelayState=${encodeURIComponent(
                     RelayState
                  )}&SAMLResponse=${encodeURIComponent(SAMLResponse)}`,
                  headers: {
                     'Content-Type': 'application/x-www-form-urlencoded',
                  },
               })
               if (!redirect.ok) {
                  return reject(`LOGIN ERROR (status: ${redirect.status})`)
               }
            }
         }
         return resolve(true)
      }
      return reject(`LOGIN ERROR (status: ${testResponse.status})`)
   })
}

/**
 * Function that recursively counts the elements of a directory
 */
const countFiles = (code, type, size) => {
   const conn = ServiceWorkerState.getConn()
   return new Promise(async (resolve, reject) => {
      if (type == 'file') {
         ServiceWorkerState.incrementFileStats(size, 0)
         return resolve(true)
      }
      if (type == 'dir') {
         const response = await fetchUrl(conn.url, code)
         if (response.ok) {
            const list = await response.json()
            await Promise.all(
               list.result.map(async (item) => {
                  if (!item.link) await countFiles(item.code, item.type, item.size)
                  updateUI('fetch', ServiceWorkerState.getFileStats().count)
               })
            )
         }
         return resolve(true)
      }
   })
}

/**
 * Wrapper to fetch()
 */
const fetchUrl = async (url, code) => {
   return await fetch(url, {
      method: 'POST',
      credentials: 'same-origin',
      body: `action=list&code=${encodeURIComponent(code)}`,
      headers: {
         'Content-Type': 'application/x-www-form-urlencoded',
      },
   })
}

/**
 * sendMessage() to content_script.js for updating the UI
 */
const updateUI = (type, data = undefined) => {
   chrome.tabs.sendMessage(ServiceWorkerState.getTab().id, { type, data })
}