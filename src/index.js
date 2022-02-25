const {
  BaseKonnector,
  requestFactory,
  scrape,
  log,
  utils,
  saveFiles
} = require('cozy-konnector-libs')

const request = requestFactory({
  // The debug mode shows all the details about HTTP requests and responses.
  // Very useful for debugging but very verbose. This is why it is commented out by default
  debug: false,

  // Activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,

  // If cheerio is activated, do not forget to deactivate json parsing
  // (which is activated by default in cozy-konnector-libs)
  json: false,

  // This allows request-promise to keep cookies between requests
  jar: true
})

const VENDOR = 'Mutuelle de Poitiers Assurances'
const baseUrl = 'https://espace-perso.assurance-mutuelle-poitiers.fr'

module.exports = new BaseKonnector(start)


/**
 * The start function is run by the BaseKonnector instance only when it got all
 * the account information (fields).
 * @param {object} fields: When you run this connector yourself in "standalone" mode
 * or "dev" mode, the account information come from ./konnector-dev-config.json file.
 * @param {object} cozyParameters: static parameters, independents from the account.
 * Most often, it can be a secret api key.
*/
async function start(fields, cozyParameters) {
  
  log('info', 'Authenticating ...')
  if (cozyParameters) log('debug', 'Found COZY_PARAMETERS')
  await authenticate.bind(this)(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Fetching the list of invoices')
  const files = await getInvoices()

  log('info', 'Fetching the list of contracts')
  const contracts = await getContracts()

  log('info', 'Fetching the list of documents for each contract')
  for (contract of contracts) {
    docs = await getContractDocs(contract)
    files.push(...docs)
  }

  log('info', 'Saving files to cozy...')
  // (https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#savefiles)
  await saveFiles(files, fields, {
      sourceAccountIdentifier: fields.login,
      fileIdAttributes: ['filename', 'subPath']
  })
  
}




// authentification using the website form
async function authenticate(username, password) {

  return this.signin({

    // <form method="post" action="/identification/check" novalidate="novalidate" class="form-login">
    url: baseUrl + '/identification/check',
    formSelector: '.form-login',

    // <input type="text" class="form-control" id="username" required name="_username" placeholder="Email ou N° de sociétaire" value="">
    // <input type="password" class="form-control form-control-password" id="password" required name="_password" placeholder="Mot de passe">
    // <input type="checkbox" id="remember_me" name="_remember_me" class="sr-only form-control required" value="1" />
    formData: {
      _username: username,
      _password: password,
      _remember_me: 1
    },
    
    // The validate function will check if the login request was a success.
    // As this website always returns a statucode=200 even if the authentification
    // goes wrong, we need to check the message returned on the webpage.
    validate: (statusCode, $) => {

      const errorMsg1 = 'Les identifiants sont incorrects, merci de les saisir à nouveau' // mauvais identifiant
      const errorMsg2 = 'Veuillez entrer votre mot de passe'

      // <a id="modal-deconnexion" data-user-test="/user-test" href="/modal-deconnexion" class="navbar-user-item navbar-user-deconnexion">Me déconnecter</a>
      if ($('a[id="modal-deconnexion"]').length === 1) {
        return true
      } else if ($.html().includes(errorMsg1)) {
        log('error', errorMsg1)
        return false
      } else if ($.html().includes(errorMsg2)) {
        log('error', errorMsg2)
        return false
      } else {
        log('error', "erreur inconnue")
        log('debug', "statusCode = " + statusCode)
        log('debug', fullResponse.body)
        return false
      }
    }
  })
}



/**
 * This function parses an HTML page wrapped by a cheerio instance
 * and returns an array of JS objects (your invoices) 
 * which will be saved to the cozy by saveFiles.
 * @returns {Array}
 */
async function getInvoices() {

  const $ = await request(`${baseUrl}/cotisations`)

  // You can find documentation about the scrape function here:
  // https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape
  // cheerio (https://cheerio.js.org/) uses the same api as jQuery (http://jquery.com/)
  const files = scrape(
    $,
    {
      // The invoice date
      // <div class="row-grey-content">
      //   <span class="color-primary">29/08/2021</span>
      date: {
        sel: 'span.color-primary',
        parse: normalizeDate
      },
      // The invoice url
      // <div class="row-grey-button">
      //   <a href="/get-document/abcdef12345" title="Ouverture de l'avis d'échéance (format PDF)" [...] target="_blank">
      fileurl: {
        sel: 'div.row-grey-button a',
        attr: 'href',
        parse: formatFileurl
      }
    },
    // <div class="row" id="avis-echeance">
    //   <div class="row row-grey" data-notice="recent">   
    'div#avis-echeance div.row-grey'
  )

  return files
    .map(file => ({
      ...file,
      filename: `${utils.formatDate(file.date)}_avis_d_échéance.pdf`,
      subPath: 'factures',
      fileAttributes: {
        metadata: {
          carbonCopy: true,
          classification: 'invoicing'
        }
      }
    }))

}


/**
 * This function parses an HTML page wrapped by a cheerio instance
 * and returns an array of JS objects (the contracts associated with your account)
 * @returns {Array}
 */
async function getContracts() {

  const $ = await request(`${baseUrl}/contrats`)

  const types = {
    "vehicle": "véhicule",
    "house": "habitation",
  // Sorry, I don't own other types of contracts,
  // but feel free to had them if you do :)
  // Other types of contracts are probably close to:
  //"health": "santé",
  //"protection": "protection",
  //"leisure": "loisirs",
  //"bank": "épargne"
  }

  const contracts = []

  for (const [typeEn, typeFr] of Object.entries(types)) {

    let contract = scrape(
        $,
        {
          name: {
            sel: 'span.sr-only',
            parse: removeMultipleSpaces
          },
          subUrl: {
            sel: 'a.contract-detail-load',
            attr: 'data-contract-detail'
          }
        },
        // <div class="col-contract col-md-12" data-contract="vehicle">
        `div[data-contract=${typeEn}]`
    )

    if (contract.length) {
      contracts.push(
        ...contract.map(
          contract => ({...contract, type: typeFr })      
        )
      )
    }

  }
  
  return contracts

}


/**
 * This function parses an HTML page wrapped by a cheerio instance
 * and returns an array of JS objects (the documents associtated to the contract) 
 * which will be saved to the cozy by saveFiles.
 * @param {Object} contract
 * @returns {Array}
 */
async function getContractDocs(contract) {
  
  const response = await request(`${baseUrl}${contract.subUrl}`)
  
  const files = scrape(
    response,
    {
      filename: {
        sel: 'a',
        parse: formatFilename
      },
      fileurl: {
        sel: 'a',
        attr: 'href',
        parse: formatFileurl
      }
    },
    'ul li'
  )
  
  return files
    .map(file => ({
      ...file,
      subPath: `${contract.type}`,
      fileAttributes: {
        metadata: {
          carbonCopy: true,
          contentAuthor: VENDOR,
          title: file.filename, // TODO: quel est le metadata approprié ?
        }
      }
    }))

}




/**
 * Converts a string formatted date (dd/mm/yyyy) into a JavaScript Date object
 * @param {string} date
 * @returns {object Date}
 */
function normalizeDate(date) {
  const [day, month, year] = date.split('/')
  // JavaScript counts months from 0 to 11.
  return new Date(year, month-1, day, 0, 0, 0)
}


/**
 * Formats a truncated url to a full url
 * @param {string} subUrl
 * @returns {string}
 */
function formatFileurl(subUrl) {
  return baseUrl + subUrl
}


/**
 * Removes multiple spaces in a string
 * See https://stackoverflow.com/questions/1981349/regex-to-replace-multiple-spaces-with-a-single-space
 * @param {string} text
 * @returns {string}
 */
function removeMultipleSpaces(text) {
  return text.replace(/ +(?= )/g,'')
}


/**
 * Formats the file name
 * @param {string} text
 * @returns {string}
 */
function formatFilename(text) {
  // replaces white spaces by underscores "_" 
  // then replaces forward slashes "/" by dash "-" 
  // then adds ".pdf" at the end
  return text.replace(/\s+/g, '_').replace(/\//g, '-') + '.pdf'
}