// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

// TODO: Remove jquery dependency.
import $ = require('jquery');

import {
  PromiseDelegate
} from '@phosphor/coreutils';

import {
  ServerConnection
} from '@jupyterlab/services';

// TODO: Complete gapi typings and commit upstream.
declare let gapi: any;
declare let google: any;

/**
 * Default Client ID to let the Google Servers know who
 * we are. These can be changed to ones linked to a particular
 * user if they so desire.
 */
export
const DEFAULT_CLIENT_ID = '625147942732-t30t8vnn43fl5mvg1qde5pl84603dr6s.apps.googleusercontent.com';

/**
 * Scope for the permissions needed for this extension.
 */
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const DISCOVERY_DOCS = ['https://www.googleapis.com/discovery/v1/apis/drive/v3/rest'];

/**
 * Aliases for common API errors.
 */
const FORBIDDEN_ERROR = 403;
const RATE_LIMIT_REASON = 'rateLimitExceeded';

/**
 * A handle to the singleton GoogleAuth instance.
 */
let googleAuth: any = null;

/**
 * A promise that is resolved when the user authorizes
 * the app to access their Drive account.
 */
export
let gapiAuthorized = new PromiseDelegate<void>();

/**
 * A promise that resolves when Google Drive is ready.
 */
export
let driveReady = gapiAuthorized.promise;

/**
 * A Promise that loads the gapi scripts onto the page,
 * and resolves when it is done.
 */
export
let gapiLoaded = new Promise<void>( (resolve, reject) => {
  // Get the gapi script from Google.
  $.getScript('https://apis.google.com/js/api.js')
  .done((script, textStatus) => {
    // Load overall API.
    (window as any).gapi.load('client:auth2,drive-realtime,drive-share', () => {
      // Load client library (for some reason different
      // from the toplevel API).
      console.log("gapi: loaded onto page");
      gapi.client.init({
        discoveryDocs: DISCOVERY_DOCS,
        clientId: DEFAULT_CLIENT_ID,
        scope: DRIVE_SCOPE
      }).then(() => {
        // Check if the user is logged in and we are
        // authomatically authorized.
        googleAuth = gapi.auth2.getAuthInstance();
        if (googleAuth.isSignedIn.get()) {
          refreshAuthToken().then(() => {
            console.log("gapi: authorized.");
            gapiAuthorized.resolve(void 0);
          });
        }
        resolve();
      });
    });
  }).fail( () => {
    console.log("gapi: unable to load onto page");
    reject();
  });
});

/**
 * Constants used when attempting exponential backoff.
 */
const MAX_API_REQUESTS = 7;
const BACKOFF_FACTOR = 2.0;
const INITIAL_DELAY = 250; //250 ms

/**
 * Wrapper function for making API requests to Google Drive.
 *
 * @param request: a request object created by the Javascript client library.
 *
 * @param successCode: the code to check against for success of the request, defaults
 *   to 200.
 *
 * @param attemptNumber: the number of times this request has been made
 *   (used when attempting exponential backoff).
 *
 * @returns a promse that resolves with the result of the request.
 */
export
function driveApiRequest( request: any, successCode: number = 200, attemptNumber: number = 0): Promise<any> {
  if(attemptNumber === MAX_API_REQUESTS) {
    console.log(request);
    return Promise.reject(new Error('Maximum number of API retries reached.'));
  }
  return new Promise<any>((resolve, reject) => {
    driveReady.then(() => {
      request.then( (response: any)=> {
        if(response.status !== successCode) {
          // Handle an HTTP error.
          console.log("gapi: Drive API error: ", response.status);
          console.log(response, request);
          reject(makeError(response.result));
        } else {
          // For some reason, response.result is 
          // sometimes empty, but the required
          // result is in response.body. This is
          // not really documented anywhere I can
          // find, but this seems to fix it.
          if(response.result === false) {
            resolve(response.body);
          } else {
            resolve(response.result);
          }
        }
      }, (response: any) => {
        // Some other error happened. If we are being rate limited,
        // attempt exponential backoff. If that fails, bail.
        if(response.status === FORBIDDEN_ERROR &&
           response.result.error.errors[0].reason === RATE_LIMIT_REASON) {
          console.log("gapi: Throttling...");
          window.setTimeout( () => {
            // Try again after a delay.
            driveApiRequest(request, successCode, attemptNumber+1)
            .then((result: any) => {
              resolve(result);
            });
          }, INITIAL_DELAY*Math.pow(BACKOFF_FACTOR, attemptNumber));
        } else {
          console.log(response, request);
          reject(makeError(response.result));
        }
      });
    });
  });
}

/**
 * Timer for keeping track of refreshing the authorization with
 * Google drive.
 */
let authorizeRefresh: any = null;

/**
 * Ask the user for permission to use their Google Drive account.
 * First it tries to authorize without a popup, and if it fails, it
 * creates a popup. If the argument `allowPopup` is false, then it will
 * not try to authorize with a popup.
 *
 * @returns: a promise that resolves with a boolean for whether permission
 *   has been granted.
 */
export
function signIn(clientId: string): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    gapiLoaded.then(() => {
      if (!googleAuth.isSignedIn.get()) {
        googleAuth.signIn().then((result: any) => {
          refreshAuthToken();
          // Resolve the exported promise.
          gapiAuthorized.resolve(void 0);
          resolve(true);
        });
      } else {
        // Otherwise we are already signed in.
        // Resolve the exported promise.
        gapiAuthorized.resolve(void 0);
        resolve(true);
      }
    });
  });
}

/**
 * Refresh the authorization token for Google APIs.
 *
 * #### Notes
 * Importantly, this calls `gapi.auth.setToken`.
 * Without this step, the realtime API will not pick
 * up the OAuth token, and it will not work. This step is
 * completely undocumented, but without it we cannot
 * use the newer, better documented, undeprecated `gapi.auth2`
 * authorization API.
 */
function refreshAuthToken(): Promise<any> {
  return new Promise<any>((resolve, reject) => {
    let user = googleAuth.currentUser.get();
    user.reloadAuthResponse().then((authResponse: any) => {
      gapi.auth.setToken(authResponse, (result: any) => {
        // Set a timer to refresh the authorization.
        if(authorizeRefresh) clearTimeout(authorizeRefresh);
        authorizeRefresh = setTimeout(() => {
          console.log('gapi: refreshing authorization.')
          refreshAuthToken();
        }, 750 * Number(authResponse.expires_in));
        resolve(result);
      });
    });
  });
}

/**
 * We do not automatically have permission to access files in a user's 
 * Google Drive which have not been created by this app. If such a file
 * is requested, we need to open a picker dialog to explicitly grant those
 * permissions.
 *
 * @param resource: the files resource that has been requested.
 * 
 * @returns a promise the resolves when the file has been picked.
 */
export
function pickFile(resource: any, clientId: string): Promise<void> {
  let appId = clientId.split('-')[0];
  return new Promise<any>((resolve,reject) => {
    let pickerCallback = (response: any) => {
      // Resolve if the user has picked the selected file.
      if(response[google.picker.Response.ACTION] ===
         google.picker.Action.PICKED &&
         response[google.picker.Response.DOCUMENTS][0][google.picker.Document.ID] ===
         resource.id) {
        resolve(void 0);
      } else if(response[google.picker.Response.ACTION] ===
         google.picker.Action.PICKED &&
         response[google.picker.Response.DOCUMENTS][0][google.picker.Document.ID] !==
         resource.id) {
        reject(new Error('Wrong file selected for permissions'));
      } else if(response[google.picker.Response.ACTION] ===
         google.picker.Action.CANCEL) {
        reject(new Error('Insufficient permisson to open file'));
      }
    }
    driveReady.then(() => {
      let pickerView = new google.picker.DocsView(google.picker.ViewId.DOCS)
          .setMode(google.picker.DocsViewMode.LIST)
          .setParent(resource.parents[0])
          .setQuery(resource.name);

      let picker = new google.picker.PickerBuilder()
        .addView(pickerView)
        .enableFeature(google.picker.Feature.NAV_HIDDEN)
        .setAppId(appId)
        .setOAuthToken(gapi.auth.getToken()['access_token'])
        .setTitle('Select to authorize opening this file with JupyterLab...')
        .setCallback(pickerCallback)
        .build();
      picker.setVisible(true);
    });
  });
}

/**
 * Wrap an API error in a hacked-together error object
 * masquerading as an `IAJaxError`.
 */
export
function makeError(result: any): ServerConnection.IError {
  let xhr = {
    status: result.error.code,
    responseText: result.error.message
  };
  return {
    event: undefined,
    xhr: xhr as XMLHttpRequest,
    ajaxSettings: null,
    throwError: xhr.responseText,
    message: xhr.responseText
  } as any as ServerConnection.IError;
}
