const africasTalking = require('africastalking');
const secureSettings = require('@medic/settings');
const logger = require('../logger');
const config = require('../config');

// Map of sending statuses to Medic statuses
// https://build.at-labs.io/docs/sms%2Fsending
const STATUS_MAP = {
  // success
  100: { success: true, state: 'forwarded-by-gateway', detail: 'Processed' },
  101: { success: true, state: 'sent', detail: 'Sent' },
  102: { success: true, state: 'received-by-gateway', detail: 'Queued' },

  // failure
  401: { success: false, state: 'failed', detail: 'RiskHold' },
  402: { success: false, state: 'failed', detail: 'InvalidSenderId', retry: true },
  403: { success: false, state: 'failed', detail: 'InvalidPhoneNumber' },
  404: { success: false, state: 'failed', detail: 'UnsupportedNumberType' },
  405: { success: false, state: 'failed', detail: 'InsufficientBalance', retry: true },
  406: { success: false, state: 'denied', detail: 'UserInBlacklist' },
  407: { success: false, state: 'failed', detail: 'CouldNotRoute' },
  500: { success: false, state: 'failed', detail: 'InternalServerError', retry: true },
  501: { success: false, state: 'failed', detail: 'GatewayError', retry: true },
  502: { success: false, state: 'failed', detail: 'RejectedByGateway', retry: true },
};

const getCredentials = () => {
  const settings = config.get('sms');
  const username = settings &&
                   settings.africas_talking &&
                   settings.africas_talking.username;
  if (!username) {
    // invalid configuration
    return Promise.reject('No username configured. Refer to the Africa\'s Talking configuration documentation.');
  }
  return secureSettings.getCredentials('africastalking.com')
    .then(apiKey => {
      if (!apiKey) {
        return Promise.reject('No api configured. Refer to the Africa\'s Talking configuration documentation.');
      }
      return { apiKey, username, from: settings.reply_to };
    });
};

const getRecipient = res => {
  return res &&
         res.SMSMessageData &&
         res.SMSMessageData.Recipients &&
         res.SMSMessageData.Recipients.length &&
         res.SMSMessageData.Recipients[0];
};

const getStatus = recipient => recipient && STATUS_MAP[recipient.statusCode];

const generateStateChange = (message, res) => {
  const recipient = getRecipient(res);
  if (!recipient) {
    return;
  }
  const status = getStatus(recipient);
  if (!status || status.retry) {
    return;
  }
  return {
    messageId: message.id,
    gatewayRef: recipient.messageId,
    state: status.state,
    details: status.detail
  };
};

const sendMessage = (instance, from, message) => {
  return instance.SMS
    .send({
      to: [ message.to ],
      from: from,
      message: message.content
    })
    .catch(res => {
      // The AT instance sometimes throws responses and sometimes errors...
      const validResponse = getStatus(getRecipient(res));
      if (!validResponse) {
        logger.error(`Error thrown trying to send messages: %o`, res);
        return; // unknown error
      }
      return res;
    })
    .then(res => generateStateChange(message, res));
};

module.exports = {
  /**
   * Given an array of messages returns a promise which resolves an array
   * of responses.
   * @param messages An Array of objects with a `to` String and a `message` String.
   * @return A Promise which resolves an Array of state change objects.
   */
  send: messages => {
    // get the credentials every call so changes can be made without restarting api
    return getCredentials().then(credentials => {
      const instance = module.exports._getInstance(credentials);
      return messages.reduce((promise, message) => {
        return promise.then(changes => {
          return sendMessage(instance, credentials.from, message).then(change => {
            if (change) {
              changes.push(change);
            }
            return changes;
          });
        });
      }, Promise.resolve([]));
    });
  },

  _getInstance: ({ apiKey, username }) => africasTalking({ apiKey, username })

};
