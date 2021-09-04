//  Babelfish node.js with socket.io to use Google Cloud Speech-to-text
//  Credits: based on Google Cloud Speech Playground by Vinzenz Aubry for sansho 24.01.17 (vinzenz@sansho.studio)

'use strict';
require('dotenv').config();
var XMLHttpRequest = require("xmlhttprequest").XMLHttpRequest; // for DeepL REST API

const os = require('os');
console.log (`(app.js) Hostname: ${os.hostname()}`);
var APPENV;
if (os.hostname() === 'localhost' || os.hostname() === '127.0.0.1' || os.hostname() === 'LTW10074') {
	// Development environment on localhost
	APPENV='DEV';
} else {
	// Environment is Heroku staging or production, we do not distinguish between those two
	APPENV='PROD';
}

const FAKETRANSLATION = (process.env.FAKE_TRANSLATION=="TRUE") ? true : false; // Use this to fake translations and avoid DeepL costs

const path = require('path');

const PORT = process.env.PORT || 1337;

// VAPID: Webpush only
// const PUBLICVAPIDKEY = process.env.PUBLIC_VAPID_KEY;
// const PRIVATEVAPIDKEY = process.env.PRIVATE_VAPID_KEY;
const VERSION = process.env.VERSION;
const GOOGLESTREAMINITIALTIMEOUT = process.env.GOOGLE_STREAM_INITIAL_TIMEOUT; // Time to wait before we close the recognition stream
const GOOGLESTREAMNODATATIMEOUT = process.env.GOOGLE_STREAM_NO_DATA_TIMEOUT; // Time to wait before we close a stream that has received data
const GOOGLEPROJECTIDTHEO = process.env.GOOGLE_PROJECT_ID_THEO // Google project id for Theo
const JWTCLIENTEMAILTHEO = process.env.JWT_CLIENT_EMAIL_THEO;
const JWTPRIVATEKEYTHEO = process.env.JWT_PRIVATE_KEY_THEO;
const GOOGLEPROJECTIDHERMILIO = process.env.GOOGLE_PROJECT_ID_HERMILIO // Google project id for Hermilio
const JWTCLIENTEMAILHERMILIO = process.env.JWT_CLIENT_EMAIL_HERMILIO;
const JWTPRIVATEKEYHERMILIO = process.env.JWT_PRIVATE_KEY_HERMILIO;
const GOOGLEPROJECTIDBABELFISH = process.env.GOOGLE_PROJECT_ID_BABELFISH // Google project id for BABELFISH
const JWTCLIENTEMAILBABELFISH = process.env.JWT_CLIENT_EMAIL_BABELFISH;
const JWTPRIVATEKEYBABELFISH = process.env.JWT_PRIVATE_KEY_BABELFISH;
//const JWTPRIVATEKEYBABELFISH = process.env.JWT_PRIVATE_KEY_BABELFISH.replace(/\\n/g, '\n'); // local only / https://stackoverflow.com/questions/50299329/node-js-firebase-service-account-private-key-wont-parse
const GOOGLEMINRESULTCONFIDENCE = process.env.GOOGLE_MIN_RESULT_CONFIDENCE/100;
const DEEPLRESTURL = process.env.DEEPL_REST_URL;
const DEEPLACCESSKEY = process.env.DEEPL_ACCESS_KEY;

// Files to serve
const INDEX = path.join(__dirname, '/public/index.html');
const PUSHFORM = path.join(__dirname, '/public/pushform.html');
const FAVICON = path.join(__dirname, '/public/favicon.ico');

// Allowed origins for CORS
const ALLOWEDORIGINS = process.env.ALLOWED_ORIGINS.split(' ');
const ALLOWEDSOCKETORIGINS = process.env.ALLOWED_SOCKET_ORIGINS.split(' ');

// SHA256 hash function and node-fetch for REST
const sha256 = require ('./sha256.js');
const fetch = require("node-fetch");

// Body parser for POST requests (/save-subscription, /send-push)
const bodyParser = require('body-parser');

// Express & socket.io server
// SSL termination is done on Heroku servers/load-balancers before the traffic gets to the application.
// So when SSL (https) traffic comes in, it is "stopped" (terminated) at the server. That server opens
// a new http connection to our dyno, and whatever is gets it sends back over https to the client.

const fs = require('fs'),
	express = require('express'),
	app = express();	

var httpServer, firebaseSubscriptionsUrl;

// Set environment according to APP_ENV from .env
console.log ('(app.js) Version: ' + VERSION);
console.log ('(app.js) *** ENV is ' + APPENV + ' ***');
if (FAKETRANSLATION) console.log (`(app.js) *** Translations are FAKE ***`);

if (APPENV == "DEV") {
	// Configure for localhost (HTTPS)
	let https = require('https'),
		privateKey  = fs.readFileSync('server.key', 'utf8'),
		certificate = fs.readFileSync('server.crt', 'utf8'),
		credentials = {key: privateKey, cert: certificate};
	httpServer = https.createServer(credentials, app);
} else {
	// Configure for Heroku (no HTTPS!), staging and production
	// Hint: there is no subscriptions database for 'staging', using 'production'
	let http = require ('http');
	httpServer = http.createServer (app);
}

const io = require('socket.io').listen(httpServer);
io.origins(ALLOWEDSOCKETORIGINS);
console.log (`(app.js) Allowed socket.io origins: ${ALLOWEDSOCKETORIGINS}`);

httpServer.listen(PORT, () => console.log(`(app.js) Listening on ${ PORT }`));

// Catch server errors
httpServer.on('error', err =>{
	console.warn ('(app.js) SERVER ERRROR ' + err);
});

// ======= WEBPUSH =======
// const webpush = require('web-push');
// webpush.setVapidDetails('mailto:cyrill.schneider@app.ch', PUBLICVAPIDKEY, PRIVATEVAPIDKEY);

// ======= EXPRESS SERVER =======
// Body parser for POST requests
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());

// Enable CORS headers for requests
app.use(function(req, res, next) {
	//res.header("Access-Control-Allow-Origin", "*");
	let origin = req.get('origin');
	if (ALLOWEDORIGINS.includes(origin)) {
		// Origin is in list, set CORS allow headers
		res.header("Access-Control-Allow-Origin", origin);
		res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
		res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
	} else {
		console.warn ('(app.js) CORS settings do not allow access from origin: ' + origin);
	}
	next();
});

app.get('/', (req, res) => {
	// Serve request for index file
	console.log ('(app.js) GET ' + INDEX);
	res.sendFile(INDEX);
});

app.get('/favicon.ico', (req, res) => {
	// Serve request for favicon
	console.log ('(app.js) GET ' + FAVICON);
	res.sendFile(FAVICON);
});

app.get('/status', (req,res) => {
	// Simple status page to show connections
	console.log ('(app.js) GET Status');
	let html='<HTML><HEAD><TITLE>Node.js Status Page</TITLE></HEAD><BODY>';
	html += `<H2>Socket.io Sessions (Clients): ${Object.keys(socketClients).length}</H2>`;
	
	for (var key in socketClients) {
		// skip loop if the property is from prototype
		if (!socketClients.hasOwnProperty(key)) continue;
		html += `- [active: ${socketClients[key].active}] socketClient {${key}} for ${socketClients[key].agent} created ${secondsBetweenDates(Date.now(),socketClients[key].created)} seconds ago with sampleRate of ${socketClients[key].sampleRateHertz} Hz<BR>`;
	}

	html += `<H2>Google Cloud Plattform Sessions: ${Object.keys(googleClients).length}</H2>`;

	for (var key in googleClients) {
		// skip loop if the property is from prototype
		if (!googleClients.hasOwnProperty(key)) continue;
		html += `- [active: ${googleClients[key].active}] googleClient {${key}} for ${googleClients[key].sessionPath}, hasReceivedData: ${googleClients[key].hasReceivedData}, last was ${secondsBetweenDates(Date.now(),googleClients[key].sessionsClientLastData)} seconds ago<BR>`;
	}
	res.send(html);

});

// ======= PWA: SAVE SUBSCRIPTION =======

app.post('/save-subscription', (req, res) => {
	// The clients call this method to save their push subscription
	let subscription = req.body,
		endpoint = subscription.endpoint,
		p256dh = subscription.keys.p256dh,
		auth = subscription.keys.auth,
		hash = sha256.hash(endpoint); // Generate SHA256 as key for Firebase node
	
	// Save subscription to Firebase
	let result = saveSubscription (endpoint, p256dh, auth, hash);
	if (result==='OK') {
		res.status(200).send();
	} else {
		res.status(500).send(result);
	}
});

// ======= PWA: PUSH NOTIFICATIONS =======

app.get('/pushform', (req, res) => {
	// Serve request for send push notification form
	// FIXME: This should be protected to prevent abuse
	console.log ('(app.js) GET ' + PUSHFORM);
	res.sendFile(PUSHFORM);
});

app.post('/send-push', (req, res) => {
	// Send push notification to each subscription in database
	// Fetch subscriptions from Firebase database
	let url = firebaseSubscriptionsUrl + '.json',
		requestParameters = {
		method:'GET',
		headers: {'Content-Type':'application/json; charset=utf-8'}
		//body:jsonData
	}
	console.log ('(app.js) Fetching subscriptions from Firebase');
	fetch(url,requestParameters)
	.then(res => res.json())
	.then(subscriptions=> {
		for (var key in subscriptions) {
			// Send push notification to each subscription is database
			// skip loop if the property is from prototype
			if (!subscriptions.hasOwnProperty(key)) continue;

			var obj = subscriptions[key];
			// console.log('(app.js) Got subscription with key: ' + key);
			let pushSubscription = {
				endpoint: obj.endpoint,
				keys: {
				  auth: obj.auth,
				  p256dh: obj.p256dh
				}
			  };
			
			// Create the push notification content
			let pushSubscriptionContent = JSON.stringify({
				title: req.body.push_title,
				icon: req.body.push_icon,
				badge: req.body.push_badge,
				url: req.body.push_url,
				image: req.body.push_image,
				body: req.body.push_message
			  });

			//console.log ('(app.js) Push content: ' + pushSubscriptionContent);

			// Send the push notification
			webpush.sendNotification(
				pushSubscription, 
				pushSubscriptionContent
			)
			.then (() => {
				console.log('(app.js) - Sent push message to (auth): ' + pushSubscription.keys.auth);
			})
			.catch (error =>{
				console.log('(app.js) - Error sending push message to (auth): ' + pushSubscription.keys.auth);
				
				// Subscription no longer active, delete from database
				deleteSubscription (pushSubscription.endpoint);
			});
		}
	}).then( () => {
		let pushResult='Test Pushnachricht an alle registrierten Benutzer versendet.';
		res.status(200).send(pushResult);
	})
	.catch(err=> {
		console.log('(app.js) GET error for push subscriptions: ' + err);
		res.status(500).send(err);
	})
});

// ======= SOCKET.IO FUNCTIONS / EVENTS =======

// FIXME: restrict access to socket.io
//io.set('origins', 'https://127.0.0.1:1443');
var socketClients = {};

io.on('connection', client => {
	// Add client.id to socketClients object, return number of active clients
	if (!socketClients[client.id]) {socketClients[client.id] = {key : client.id, active : true, created: Date.now()}};

	console.log(`(app.js) (${client.id}) Client connected to server. Total # of socket clients: ${Object.keys(socketClients).length}`);
	io.to(client.id).emit ('message', `Client Connected to server with ID=${client.id}`);

    client.on('googleAgent', data => {
		// Client sent the DailogFlow agent to use ("THEO" or "HERMILIO") or Google Cloud STT ("BABELFISH")
		socketClients[client.id].agent=data;
		console.log(`(app.js) (${client.id}) Agent is: ${socketClients[client.id].agent}`);
    });

	client.on('disconnect', data => {
		// Set googleClients[client.id] to inactive
		if (googleClients[client.id]) {
			// Call stopRecognitionStream to end any active streams and sessions clients, if existing
			stopRecognitionStream(client.id, false)
			// Set the element in googleClients object to inactive. Do not delete here since asynch request might still send data
			//delete googleClients[client.id];
			googleClients[client.id].active=false;
			console.log (`(app.js) (${client.id}) Setting client from googleClients to inactive. Total # of google clients: ${Object.keys(googleClients).length}`);
		}
		// Set socketClients[client.id] to inactive
		if (socketClients[client.id]) {
			// Set the element in googleClients object to inactive. Do not delete here since asynch request might still send data
			//delete socketClients[client.id];
			socketClients[client.id].active=false;
			console.log(`(app.js) (${client.id}) Client disconnected from server, setting to inactive. Total # of socket clients: ${Object.keys(socketClients).length}`);
		}
	});

    client.on('startGoogleCloudStream', data => {
		// Received command to start google cloud stream for this client.id
		console.log (`(app.js) (${client.id}) Received command to start GCP stream`);
        startRecognitionStream(this, client.id, data);
    });

    client.on('endGoogleCloudStream', data => {
		// Received command to stop google cloud stream for this client.id
		console.log (`(app.js) (${client.id}) Received command to stop GCP stream`);
        stopRecognitionStream(client.id, false);
    });

	client.on('setSampleRateHertz', data => {
		// Received command to set sample rate (in Hz) for this client.id
		console.log (`(app.js) (${client.id}) Received command to set sample hertz rate to ${data}`);
		socketClients[client.id].sampleRateHertz=data;
    });

    client.on('binaryAudioData', data => {
		// Received binary audio data for this client.id
		if (socketClients[client.id].agent=="THEO" || socketClients[client.id].agent=="HERMILIO") {
			if (googleClients[client.id] && googleClients[client.id].detectStream !== null && !googleClients[client.id].detectStreamIsFinal) {
				// DialogFlow stream available, forward audio data from client
				googleClients[client.id].detectStream.write({ inputAudio: (data)});
				// Check to see if this stream has not returned any data for a while
				if (googleClients[client.id].hasReceivedData && googleClients[client.id].active) {
					// Active stream that has received some data, check for timeout
					if (secondsBetweenDates(Date.now(),googleClients[client.id].sessionsClientLastData)>GOOGLESTREAMNODATATIMEOUT) {
						console.log (`(app.js) (${client.id}) No more data received from detectIntent for ${GOOGLESTREAMNODATATIMEOUT} seconds. Ending stream.`);
						stopRecognitionStream(client.id, false);
					}
				} else {
					if (secondsBetweenDates(Date.now(),googleClients[client.id].sessionsClientLastData)>GOOGLESTREAMINITIALTIMEOUT) {
						console.log (`(app.js) (${client.id}) No data received from detectIntent for ${GOOGLESTREAMINITIALTIMEOUT} seconds. Are you there?`);
						// No data received at all, shutting down and sending information to client 
						stopRecognitionStream(client.id, true);
					}
				}
			}
		} else if (socketClients[client.id].agent=="BABELFISH") {
			if (googleClients[client.id] && googleClients[client.id].detectStream !== null && !googleClients[client.id].detectStreamIsFinal) {
				// Stream available, forward audio data from client
				googleClients[client.id].detectStream.write(data);
				// Check to see if this stream has not returned any data for a while
				if (googleClients[client.id].hasReceivedData && googleClients[client.id].active) {
					// Active stream that has received some data, check for timeout
					if (secondsBetweenDates(Date.now(),googleClients[client.id].sessionsClientLastData)>GOOGLESTREAMNODATATIMEOUT) {
						console.log (`(app.js) (${client.id}) No more data received from detectIntent for ${GOOGLESTREAMNODATATIMEOUT} seconds. Initiating translation and ending stream.`);
						initiateTranslation(client.id, recognitionResult.transcript, recognitionResult.confidence, true); // initiate translation if end of phrase was not detected
						stopRecognitionStream(client.id, true);
					}
				} else {
					if (secondsBetweenDates(Date.now(),googleClients[client.id].sessionsClientLastData)>GOOGLESTREAMINITIALTIMEOUT) {
						console.log (`(app.js) (${client.id}) No data received from detectIntent for ${GOOGLESTREAMINITIALTIMEOUT} seconds. Are you there?`);
						// No data received at all, shutting down and sending information to client 
						stopRecognitionStream(client.id, true);
					}
				}
			}		
		}
    });
});


// ======= FIREBASE DATABASE FUNCTIONS FOR SUBSCRIPTIONS =======

function saveSubscription (endpoint, p256dh, auth, hash) {
	// Save the subscription to Firebase
	let now = new Date();
	let jsonData = JSON.stringify({endpoint:endpoint, p256dh:p256dh, auth:auth, lasttimestampUTC:now}),
	url = firebaseSubscriptionsUrl + '/' + hash + '.json',
	requestParameters = {
		method:'PUT',
		headers: {'Content-Type':'application/json; charset=utf-8'},
		body:jsonData
	};
	console.log ('(app.js) POST - Saving subscription with key: ' + hash + ' to ' + firebaseSubscriptionsUrl);
	//console.log (requestParameters);

	// Save subscription to firebase using REST PUT
	fetch(url,requestParameters)
	.then(res => res.json())
	.then(json=> {
	console.log('(app.js) PUT of subscription to database successful');
	 return 'OK';
	})
	.catch(err=> {
	console.log ('(app.js) PUT of subscription to database caused an error: ' + err);		
	return err;
	})
	return 'OK';
}

function deleteSubscription (endpoint) {
	// Delete the subscription for the given endpoint from Firebase
	let hash = sha256.hash(endpoint); // Generate SHA256 hash as key for Firebase node
			
	let url = firebaseSubscriptionsUrl + '/' + hash + '.json',
		requestParameters = {
			method:'DELETE',
			headers: {'Content-Type':'application/json; charset=utf-8'}
		};
	console.log ('(app.js) DELETE - Deleting subscription with key: ' + hash + ' @ ' + url);
	//console.log (requestParameters);
	
	// Delete subscription from Firebase using REST DELETE
	fetch(url,requestParameters)
	.then(res => res.json())
	.then(json=> console.log('(app.js) DELETE of subscription successful'))
	.catch(err=>console.log('(app.js) DELETE of subscription caused an error: ' + err))
}

// ======= GOOGLE DIALOWFLOW WITH SPEECH-TO-TEXT =======

// Imports the Dialogflow library
const dialogflow = require('dialogflow');
const googlespeech = require('@google-cloud/speech');


// Instantiates a session client

// Create empty object for googleClients
var googleClients = {};

// Create recognition result for Google speech to text (BABELFISH)
var recognitionResult;

function startRecognitionStream(client, clientId, data) {

	// Google settings for audio stream and speech-to-text

	let encoding = 'AUDIO_ENCODING_LINEAR_16';
	let sampleRateHertz = socketClients[clientId].sampleRateHertz;
	let languageCode = 'de-DE'; //de-DE en-US

	// AudioConfig for DialogFlow: https://pub.dev/documentation/googleapis/latest/googleapis.dialogflow.v2/GoogleCloudDialogflowV2InputAudioConfig-class.html
	// AudioConfig for Streaming recognition: https://cloud.google.com/speech-to-text/docs/reference/rpc/google.cloud.speech.v1?hl=ru#google.cloud.speech.v1.StreamingRecognitionConfig
	let audioConfig;
	if (socketClients[clientId].agent=="THEO") {
		audioConfig	= {
			"audioEncoding": encoding,
			"sampleRateHertz": sampleRateHertz,
			"languageCode": languageCode,
			"singleUtterance" : false, // does this work?
			// no longer available? "profanityFilter": true,
			//enableWordTimeOffsets: true,
			"phraseHints": [
				'Accenture',
				'APP',
				'APP Unternehmensberatung',
				'APP Unternehmensberatung AG',
				'Apps',
				'Assessment',
				'AWK',
				'BCG',
				'case study',
				'CEO',
				'Chief Executive Officer',
				'Consultant',
				'Deloitte',
				'Boston Consulting Group',
				'Deloitte',
				'ERNI Consulting',
				'Ernst and Young',
				'EY',
				'IT',
				'Junior',
				'PWC',
				'Senior',
				'Theo',
				'Website'
			]
			// interimResults no longer needs to be set
			//interimResults: true,
		}
	} else if (socketClients[clientId].agent=="HERMILIO") {
		audioConfig	= {
			"audioEncoding": encoding,
			"sampleRateHertz": sampleRateHertz,
			"languageCode": languageCode,
			"singleUtterance" : false, // does this work?
			"phraseHints": [
				'APP',
				'APP Unternehmensberatung',
				'APP Unternehmensberatung AG',
				'Hermilio',
				'HERMES',
				'Website'
			]
		}
	} else if (socketClients[clientId].agent=="BABELFISH") {
		encoding="LINEAR16";
		/*audioConfig	= {
			config: {
				encoding: encoding,
				sample_rate_hertz: sampleRateHertz,
				language_code: languageCode,
				profanity_filter: false,
				enable_automatic_punctuation: true
			},
			single_utterance : false, 
			interim_results: true			
		}
		*/
		const config = {
			encoding: encoding,
			sampleRateHertz: sampleRateHertz,
			alternativeLanguageCodes: ["fr-FR"], // FIXME: doesn't work right yet 
			languageCode: languageCode // FIXME: should be configured above
		};
		
		audioConfig = {
			config,
			interimResults: true
		};
		console.log (JSON.stringify(audioConfig));
	};

	
	if (!googleClients[clientId]) {googleClients[clientId] = {sessionsClient : ''}};
	// Save creation time of this sessionsClient
	googleClients[clientId].sessionsClientLastData = Date.now();
	googleClients[clientId].hasReceivedData=false;
	googleClients[clientId].active=true;

	// Set the google session credentials depending on the current agent
	let projectId, credentials;
	if (socketClients[clientId].agent=="THEO") {
		projectId = GOOGLEPROJECTIDTHEO;
		credentials = {
			client_email: JWTCLIENTEMAILTHEO,
			private_key: JWTPRIVATEKEYTHEO
		};
	} else if (socketClients[clientId].agent=="HERMILIO")	{
		projectId = GOOGLEPROJECTIDHERMILIO;
		credentials = {
			client_email: JWTCLIENTEMAILHERMILIO,
			private_key: JWTPRIVATEKEYHERMILIO
		};
	} else if (socketClients[clientId].agent=="BABELFISH")	{
		projectId = GOOGLEPROJECTIDBABELFISH;
		credentials = {
			client_email: JWTCLIENTEMAILBABELFISH,
			private_key: JWTPRIVATEKEYBABELFISH
		};
	} else {
		console.error (`(app.js) (${clientId}) Unknown agent type: ${socketClients[clientId].agent}`)
	}

	// Create a Google SessionsClient for the current clientId
	if (socketClients[clientId].agent=="THEO" || socketClients[clientId].agent=="HERMILIO") {
		googleClients[clientId].sessionsClient = new dialogflow.SessionsClient({
			projectId, 
			credentials
		});
	googleClients[clientId].sessionPath = googleClients[clientId].sessionsClient.sessionPath(projectId, clientId);
	} else if (socketClients[clientId].agent=="BABELFISH") {
		console.log (`(app.js) (${clientId}) Creating Google SpeechClient: ${socketClients[clientId].agent}`)
		googleClients[clientId].sessionsClient = new googlespeech.SpeechClient({
			projectId, 
			credentials
		});
	} 
	
	console.log (`(app.js) (${clientId}) Added client to googleClients @ ${Date(googleClients[clientId].sessionsClientLastData).toLocaleString()}. Total # of google clients: ${Object.keys(googleClients).length}`)
	// Initialize isFinal as false, nothing has been detected yet
	googleClients[clientId].detectStreamIsFinal = false;

	if (socketClients[clientId].agent=="THEO" || socketClients[clientId].agent=="HERMILIO") {
		// Create a new detect stream for the sessionsClient
		googleClients[clientId].detectStream = googleClients[clientId].sessionsClient
		.streamingDetectIntent()
		.on('data', data => {
			//console.log ('(app.js) interim message: ' + JSON.stringify(data));
			// StreamingDetectIntentResponse: DialogFlow sends several messages back
			// 1. If the input was set to streaming audio (=yes), the first one or more messages contain recognition_result. Each recognition_result represents a more complete transcript of what the user said. The last recognition_result has is_final set to true.
			// 2. The next message contains response_id, query_result and optionally webhook_status if a WebHook was called (=no).
			if (data.recognitionResult) {
				// Update last data received information on this clientId
				googleClients[clientId].sessionsClientLastData = Date.now();
		
				if (!data.recognitionResult.isFinal) {
					// Intermediate response from Google streamingDetect
					console.log(`(app.js) (${clientId}) Intermediate transcription (type=${data.recognitionResult.messageType}): ${data.recognitionResult.transcript}`);
					// Send speech recognition data to this clientId via socket
					io.to(clientId).emit('speechData', data);
					// Save information that data was received for this clientId
					googleClients[clientId].hasReceivedData=true;
				} else {
					// Final response from Google streamingDetect
					console.log(`(app.js) (${clientId}) Final transcription (type=${data.recognitionResult.messageType}): ${data.recognitionResult.transcript}`);
					googleClients[clientId].detectStreamIsFinal=true;
					// End the detectStream for this clientId
					googleClients[clientId].detectStream.end();
					// Send speech recognition data to this clientId via socket
					io.to(clientId).emit('speechData', data);
				}
			} else if (data.queryResult) {
				// This response contains all relevant information such as detected intent and fulfillment text
				console.log(`(app.js) (${clientId}) Final queryText: ${data.queryResult.queryText}`);
				if (data.queryResult.intent) {console.log(`(app.js) (${clientId}) intentDisplayName: ${data.queryResult.intent.displayName}`)}
				//console.log('(app.js) fulfillmentMessages: ' + JSON.stringify(data));
				
				// Check if there is any data to send
				if (data.queryResult.fulfillmentMessages[0]) {
					let fulfillmentText='';
					// Loop through fulfillment messages from DialogFlow and add text lines to response
					for (let index = 0; index < data.queryResult.fulfillmentMessages.length; ++index) {
						if (data.queryResult.fulfillmentMessages[index].text) fulfillmentText += data.queryResult.fulfillmentMessages[index].text.text.toString() + "\n";
					};
					console.log(`(app.js) (${clientId}) fulfillmentMessages[].text: ${fulfillmentText}`);

					// Send speech recognition data to this clientId via socket
					console.log(`(app.js) (${clientId}) Sending final transcription to client`);
					io.to(clientId).emit('speechData', data);
				}
			} else {
				// We should never end up here
				console.log (`(app.js) (${clientId}) unhandled .on(data) event: ${JSON.stringify(data)}`);
			};
		})
		.on('error', err => {
			// Client.id will be undefined if we are shutting down
			if (typeof client.id !== 'undefined') {
				console.log (`(app.js) (${client.id}) .on ERROR: ${err.code} > ${err}`);
				if (err.code==11)
				{
					// Google error 11: audio timeout error, happens after approx 60s of streaming empty audio
					console.log (`(app.js) (${client.id}) Error 11: GCP stream inactivity timeout`);
					// Signal error to clientId via socket
					io.to(clientId).emit('googleError', err);
				}
			}
			});
	} else if (socketClients[clientId].agent=="BABELFISH") {
		// Google speech to text with DeepL translation for Babelfish
		console.log (`(app.js) (${clientId}) audioConfig ${JSON.stringify(audioConfig)}`);
		console.log (`(app.js) (${clientId}) Starting detectStream: ${socketClients[clientId].agent}`)
		googleClients[clientId].detectStream = googleClients[clientId].sessionsClient
		.streamingRecognize(audioConfig)
		.on('error', console.error)
		.on('data', data => {
			console.log ('(app.js) interim message: ' + JSON.stringify(data));
			// StreamingDetectIntentResponse: DialogFlow sends several messages back
			// 1. If the input was set to streaming audio (=yes), the first one or more messages contain recognition_result. Each recognition_result represents a more complete transcript of what the user said. The last recognition_result has is_final set to true.
			// 2. The next message contains response_id, query_result and optionally webhook_status if a WebHook was called (=no).
			recognitionResult = data.results[0].alternatives[0];

			if (recognitionResult) {
				// Update last data received information on this clientId
				googleClients[clientId].sessionsClientLastData = Date.now();
		
				if (!recognitionResult.isFinal) {
					// Intermediate response from Google streamingDetect
					// console.log(`(app.js) (${clientId}) Intermediate transcription (ST=${recognitionResult.stability}, CO=${recognitionResult.confidence}): ${recognitionResult.transcript}`);
					// Send speech recognition data to this clientId via socket
					io.to(clientId).emit('speechData', data);
					// Save information that data was received for this clientId
					googleClients[clientId].hasReceivedData=true;
					initiateTranslation(clientId, recognitionResult.transcript, recognitionResult.confidence, recognitionResult.isFinal);
				} else {
					// Final response from Google streamingDetect
					// console.log(`(app.js) (${clientId}) Final transcription (ST=${recognitionResult.stability}, CO=${recognitionResult.confidence}): ${recognitionResult.transcript}`);
					googleClients[clientId].detectStreamIsFinal=true;
					// End the detectStream for this clientId
					googleClients[clientId].detectStream.end();
					// Send speech recognition data to this clientId via socket
					io.to(clientId).emit('speechData', data);
					initiateTranslation(clientId, recognitionResult.transcript, recognitionResult.confidence, recognitionResult.isFinal);
				}
			} else if (data.queryResult) {
				// This response contains all relevant information such as detected intent and fulfillment text
				console.log(`(app.js) (${clientId}) Final queryText: ${data.queryResult.queryText}`);
				if (data.queryResult.intent) {console.log(`(app.js) (${clientId}) intentDisplayName: ${data.queryResult.intent.displayName}`)}
				//console.log('(app.js) fulfillmentMessages: ' + JSON.stringify(data));
				
				// Check if there is any data to send
				if (data.queryResult.fulfillmentMessages[0]) {
					let fulfillmentText='';
					// Loop through fulfillment messages from DialogFlow and add text lines to response
					for (let index = 0; index < data.queryResult.fulfillmentMessages.length; ++index) {
						if (data.queryResult.fulfillmentMessages[index].text) fulfillmentText += data.queryResult.fulfillmentMessages[index].text.text.toString() + "\n";
					};
					console.log(`(app.js) (${clientId}) fulfillmentMessages[].text: ${fulfillmentText}`);

					// Send speech recognition data to this clientId via socket
					console.log(`(app.js) (${clientId}) Sending final transcription to client`);
					io.to(clientId).emit('speechData', data);
				}
			} else {
				// We should never end up here
				console.log (`(app.js) (${clientId}) unhandled .on(data) event: ${JSON.stringify(data)}`);
			};
		})
		.on('error', err => {
			// Client.id will be undefined if we are shutting down
			if (typeof client.id !== 'undefined') {
				console.log (`(app.js) (${client.id}) .on ERROR: ${err.code} > ${err}`);
				if (err.code==11)
				{
					// Google error 11: audio timeout error, happens after approx 60s of streaming empty audio
					console.log (`(app.js) (${client.id}) Error 11: GCP stream inactivity timeout`);
					// Signal error to clientId via socket
					io.to(clientId).emit('googleError', err);
				}
			}
			});
	  
	}

	//console.log ('(app.js) audioConfig' + JSON.stringify(audioConfig));

	if (socketClients[clientId].agent=="THEO" || socketClients[clientId].agent=="HERMILIO") {
		// Set config in initial stream request
		const initialStreamRequest = {
			session: googleClients[clientId].sessionPath,
			"queryParams": {
				session: googleClients[clientId].sessionPath,
			},
			"queryInput": {
				"audioConfig": audioConfig
			}
		};

		console.log ('(app.js) initialStreamRequest: '  + JSON.stringify(initialStreamRequest));

		// Write the initial stream request to config audio input for this clientId
		googleClients[clientId].detectStream.write(initialStreamRequest);
	}
}

function stopRecognitionStream(clientId, signalToClient) {
	// End the google detection stream for this clientId
	if (googleClients[clientId] && googleClients[clientId].active) {
		googleClients[clientId].active=false;
		if (googleClients[clientId].detectStream) {
			// Detect stream open for this clientId, end it
			console.log (`(app.js) (${clientId}) Ending GCP stream`);
			googleClients[clientId].detectStream.end();
			googleClients[clientId].detectStream=null; //FIXME: needed?
		}
		if (googleClients[clientId].sessionsClient)
		{
			// Existing sessions client for this clientId, end it
			// We always end the sessionsClient to prevent audio timeout errors after approx 60s of empty audio
			console.log (`(app.js) (${clientId}) Ending sessionsClient`);
			googleClients[clientId].sessionsClient = null;
		}
		if (signalToClient) {
			// Audio stream did not receive any data at all, send event to client to reset
			console.log (`(app.js) (${clientId}) Stream closed`);
			io.to(clientId).emit('streamClosed', "dummy");
		}
	}
}

// ==== DEEPL FUNCTIONS ====
var lastConfidenceScore=0.8;
function initiateTranslation(clientId, sourceText, confidenceScore, isFinal) {
	if (confidenceScore>lastConfidenceScore || isFinal)
	{
		console.log (`(app.js) (${clientId}) Translation request for score ${confidenceScore} (isFinal=${isFinal}) and text "${sourceText}", last score is ${lastConfidenceScore}`);
	
		// Remember confidence score to avoid too many translation requests
		lastConfidenceScore=confidenceScore;
		if (isFinal) lastConfidenceScore=1;
		
		let xhr = new XMLHttpRequest();
		let url = DEEPLRESTURL + '?auth_key=' + DEEPLACCESSKEY + '&text=' + sourceText + '&target_lang=FR';
		let params = {
			auth_key: DEEPLACCESSKEY,
			//source_lang:"DE",
			//target_lang:"FR",
			text: sourceText
		}

		if (!FAKETRANSLATION) {
			xhr.open('POST', url, true);

			//Send the proper header information along with the request
			xhr.setRequestHeader('Content-type', 'application/x-www-form-urlencoded');
			console.log (`(app.js) (${clientId}) Sending translation request to ${url}:  ${JSON.stringify(params)}`);

			xhr.onreadystatechange = function() {//Call a function when the state changes.
				if(xhr.readyState == 4 && xhr.status == 200) {
					console.log(`(app.js) (${clientId}) Translation = "${xhr.responseText}"`);
					io.to(clientId).emit('translationFR', xhr.responseText);
					lastConfidenceScore=0.8;
				}
			}
			xhr.send(JSON.stringify(params));
		} else {
			let translationJSON = {
				translations :  [{
					detected_source_language : "DE",
					text : sourceText
				}]
			}
			console.log (`(app.js) (${clientId}) Config: translations disabled (FAKE_TRANSLATION=true) - sending source text: ${sourceText}`);
			io.to(clientId).emit('translationFR', JSON.stringify(translationJSON));
		}
	}

};

// ==== GARBAGE COLLECTION ====

// Set garbage collection to execute every 24 hours
setInterval(garbageCollection, 86400000);

// Garbage collection function to remove inactive objects (sessionClients, googleClients)
function garbageCollection () {
	console.log (`(app.js) Running garbage collection`);
	
	// Garbage collection for socketClients{}
	for (var key in socketClients) {
		// skip loop if the property is from prototype
		if (!socketClients.hasOwnProperty(key)) continue;
		if (!socketClients[key].active) {
			console.log (`(app.js) Garbage collection - dumping socketClient ${key}`);
			delete socketClients[key];
		}
	}

	// Garbage collection for googleClients{}
	for (var key in googleClients) {
		// skip loop if the property is from prototype
		if (!googleClients.hasOwnProperty(key)) continue;
		if (!googleClients[key].active) {
			console.log (`(app.js) Garbage collection - dumping googleClient ${key}`);
			delete googleClients[key];
		}
	}

}

// ==== GENERIC FUNCTIONS ====
function secondsBetweenDates (newDate, oldDate) {
	return Math.floor((newDate-oldDate) / 1000);
}
