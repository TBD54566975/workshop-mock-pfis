import './polyfills.js'
import {OfferingRepository} from './offerings.js'

import type { Rfq, Order, Message } from '@tbdex/http-server'
import { Quote, OrderStatus, Close } from '@tbdex/http-server'

import log from './logger.js'
import { config } from './config.js'
import { Postgres, ExchangeRespository } from './db/index.js'
import { HttpServerShutdownHandler } from './http-shutdown-handler.js'
import { TbdexHttpServer } from '@tbdex/http-server'
import { requestCredential } from './credential-issuer.js'


console.log('PFI DID: ', config.did.id)
console.log('PFI DID KEY: ', JSON.stringify(config.did.privateKey))
console.log('PFI KID: ', config.did.kid)


process.on('unhandledRejection', (reason: any, promise) => {
  log.error(`Unhandled promise rejection. Reason: ${reason}. Promise: ${JSON.stringify(promise)}. Stack: ${reason.stack}`)
})

process.on('uncaughtException', err => {
  log.error('Uncaught exception:', (err.stack || err))
})

// triggered by ctrl+c with no traps in between
process.on('SIGINT', async () => {
  log.info('exit signal received [SIGINT]. starting graceful shutdown')

  gracefulShutdown()
})

// triggered by docker, tiny etc.
process.on('SIGTERM', async () => {
  log.info('exit signal received [SIGTERM]. starting graceful shutdown')

  gracefulShutdown()
})

const httpApi = new TbdexHttpServer({ exchangesApi: ExchangeRespository, offeringsApi: OfferingRepository })

// provide the quote
httpApi.submit('rfq', async (ctx, rfq: Rfq) => {
  await ExchangeRespository.addMessage({ message: rfq })

  const offering = await OfferingRepository.getOffering({ id: rfq.offeringId })


  if (rfq.payinMethod.kind == 'CREDIT_CARD' && offering.payinCurrency.currencyCode == 'USD' && offering.payoutCurrency.currencyCode == 'AUD' ) {
    const quote = Quote.create(
      {
        metadata: {
          from: config.did.id,
          to: rfq.from,
          exchangeId: rfq.exchangeId
        },
        data: {
          expiresAt: new Date(2028, 4, 1).toISOString(),
          payin: {
            currencyCode: 'USDC',
            amountSubunits: '100',
          },
          payout: {
            currencyCode: 'AUD',
            amountSubunits: '110'
          }
        }
      }
    )
    await quote.sign(config.did.privateKey, config.did.kid)
    await ExchangeRespository.addMessage({ message: quote as Quote})

  }
})

// When the customer accepts the order
httpApi.submit('order', async (ctx, order: Order) => {
  console.log('order requested')
  await ExchangeRespository.addMessage({ message: order })

  // first we will charge the card
  // then we will send the money to the bank account

  const quote = await ExchangeRespository.getQuote({ exchangeId: order.exchangeId })
  const rfq = await ExchangeRespository.getRfq({ exchangeId: order.exchangeId })

  let response = await fetch('https://test-api.pinpayments.com/1/charges', {
    method: 'POST',
    headers: {

      'Authorization': 'Basic ' + Buffer.from(config.pinPaymentsKey + ':').toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'amount': quote.data.payin.amountSubunits,
      'currency': 'USD',
      'description': 'For remittances',
      'ip_address': '203.192.1.172',
      'email': 'test@testing.com',
      'card[number]': rfq.data.payinMethod.paymentDetails['cc_number'],
      'card[expiry_month]': rfq.data.payinMethod.paymentDetails['expiry_month'],
      'card[expiry_year]': rfq.data.payinMethod.paymentDetails['expiry_year'],
      'card[cvc]': rfq.data.payinMethod.paymentDetails['cvc'],
      'card[name]': rfq.data.payinMethod.paymentDetails['name'],
      'card[address_line1]': 'Nunya',
      'card[address_city]': 'Bidnis',
      'card[address_country]': 'USA',
      'metadata[OrderNumber]': '123456',
      'metadata[CustomerName]': 'Roland Robot'
    })
  })

  let data = await response.json()
  await updateOrderStatus(rfq, 'IN_PROGRESS')


  if (response.ok) {
    console.log('Charge created successfully. Token:', data.response.token)
  } else {
    console.error('Failed to create charge. Error:', data)
    await close(rfq, 'Failed to create charge.')
    return
  }


  // now transfer the the money to the bank account as AUD
  // first create a reipient and get the recipient token
  response = await fetch('https://test-api.pinpayments.com/1/recipients', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(config.pinPaymentsKey + ':').toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'email': 'roland@pinpayments.com',
      'name': 'Mr Roland Robot',
      'bank_account[name]': rfq.data.payoutMethod.paymentDetails['accountName'],
      'bank_account[bsb]':  rfq.data.payoutMethod.paymentDetails['bsbNumber'],
      'bank_account[number]': rfq.data.payoutMethod.paymentDetails['accountNumber'],
    })
  })


  data = await response.json()

  if (data.response && data.response.token) {
    console.log('Recipient created successfully. Token:', data.response.token)
  } else {
    console.log('Unable to create recipient')
    console.log(data)
    await close(rfq, 'Failed to create recipient.')
    return
  }

  const recipientToken = data.response.token
  console.log('recipient token:', recipientToken)


  await updateOrderStatus(rfq, 'TRANSFERING_FUNDS')


  response = await fetch('https://test-api.pinpayments.com/1/transfers', {
    method: 'POST',
    headers: {
      'Authorization': 'Basic ' + Buffer.from(config.pinPaymentsKey + ':').toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      'amount': quote.data.payout.amountSubunits,
      'currency': quote.data.payout.currencyCode,
      'description': 'For remittances',
      'recipient': recipientToken
    })
  })

  data = await response.json()

  if (data.response && data.response.status == 'succeeded') {
    console.log('------>Transfer succeeded!!')
    await updateOrderStatus(rfq, 'SUCCESS')
    await close(rfq, 'SUCCESS')

  } else {
    await updateOrderStatus(rfq, 'FAILED')
    await close(rfq, 'Failed to create transfer.')
  }

  console.log('all DONE')



})

httpApi.submit('close', async (ctx, close) => {
  await ExchangeRespository.addMessage({ message: close as Close })
})

const server = httpApi.listen(config.port, () => {
  log.info(`Mock PFI listening on port ${config.port}`)
})


httpApi.api.get('/', (req, res) => {
  res.send('Please use the tbdex protocol to communicate with this server or a suitable library: https://github.com/TBD54566975/tbdex-protocol')
})


// This is just for example convenience. In the real world this would be discovered by other means.
httpApi.api.get('/did', (req, res) => {
  res.send(config.did.id)
})


// A very low fi implementation of a credential issuer - will just check they are not sanctioned.
// In the real world this would be done via OIDC4VC or similar.
// In this case a check could be done on each transaction so a VC could be optional, but it makes the example richer to have it stored in the client (html) and sent with the RFQ.
httpApi.api.get('/vc', async (req, res) => {
  const credentials = await requestCredential(req.query.name as string, req.query.country as string, req.query.did as string)
  res.send(credentials)
})



const httpServerShutdownHandler = new HttpServerShutdownHandler(server)


function gracefulShutdown() {
  httpServerShutdownHandler.stop(async () => {
    log.info('http server stopped.')

    log.info('closing Postgres connections')
    await Postgres.close()

    process.exit(0)
  })
}

async function updateOrderStatus(rfq: Rfq, status: string) {
  console.log('----------->>>>>>>>>                         -------->Updating status', status)
  const orderStatus = OrderStatus.create(
    {
      metadata: {
        from: config.did.id,
        to: rfq.from,
        exchangeId: rfq.exchangeId
      },
      data: {
        orderStatus: status
      }
    }
  )
  await orderStatus.sign(config.did.privateKey, config.did.kid)
  await ExchangeRespository.addMessage({ message: orderStatus as OrderStatus})
}

async function close(rfq: Rfq, reason: string) {
  console.log('closing exchange ', reason)

  const close = Close.create(
    {
      metadata: {
        from: config.did.id,
        to: rfq.from,
        exchangeId: rfq.exchangeId
      },
      data: {
        reason: reason
      }
    }
  )
  await close.sign(config.did.privateKey, config.did.kid)
  await ExchangeRespository.addMessage({ message: close})
}