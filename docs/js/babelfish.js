'use strict'

//================= CONFIG =================

// Deployment configuration
var currentENV;
var nodeURL;
var googleAgent = 'BABELFISH'; // Set to 'THEO', 'HERMILIO' or 'BABELFISH'

if (location.hostname === "localhost" || location.hostname === "127.0.0.1") {
	currentENV='DEV';
	// Development environment on localhost 
	nodeURL='https://localhost:1337';
} else if (location.hostname === "theo-staging.web.app" || location.hostname === "theoleo-staging.web.app" || location.hostname === "cyrill-schneider.github.io"){
	currentENV='STAGE';
	// Connect to node.js on Heroku STAGING
	(googleAgent!=="BABELFISH") ?	nodeURL='https://theo-staging.herokuapp.com' : nodeURL='https://babelfish-stage.herokuapp.com';
} else {
	// FIXME 4 BABELFISH (there is a production environment for THEO only atm)
	currentENV='PROD';
	// Assuming production, connect to node.js on Heroku PRODUCTION
	nodeURL='https://theo-production.herokuapp.com';
}

console.log (`(client.js) Current env is ${currentENV}`);

// Stream Audio
var bufferSize = 2048,
	audioContext = null,
	audioSource,
	isRecording = false;

// Audio
var finalWord = false,
	resultText = document.getElementById('ResultText'),
	DFResponse = '';

const constraints = {
	audio: {
		autoGainControl: true,
		noiseSuppression: true,
		echoCancellation: false,
		channelCount: 1
	},
	video: false
};

// Output
var theoHeight,
	theoWidth;

// Critical error message
const criticalErrorMsg="Oops! Die App kann leider nicht auf dein Mikrofon zugreifen.<P>Hast du...<BR>... der App den Zugriff aufs Mikrofon erlaubt?<BR>... den Mikrofonzugriff in deinem Browser aktiviert?<P>Bitte lade die Seite im Anschluss neu und versuche es noch einmal.<P>Viel Erfolg!<P> "

// Audio chain nodes
var mediaStream, input, processor;

// Terms of use
const touText='Die Nutzung unseres Übersetzungsdienstes erfordert keine Eingabe personenbezogener Daten. Der Betrieb des Übersetzungsdienstes erfolgt durch ein Partnerunternehmen. Zur Optimierung der Funktionalitäten des Übersetzungsdienstes werden die geführten Konversationen in Textform anonymisiert aufgezeichnet und können von autorisierten Personen der APP Unternehmensberatung AG eingesehen werden. Audiodaten aus der Spracherkennung werden nicht aufgezeichnet. Detaillierte Informationen zu den datenschutzrechtlichen Aspekten finden Sie in der Datenschutzerklärung auf der Homepage der APP Unternehmensberatung AG.';

//================== SCREEN ==================
function clearInput() {
	// Clear input div
	document.getElementById('divDE').innerHTML = '';
}

var currentTextDE="";
var currentTextFR="";
var finishedPhrasesDE="";
var finishedPhrasesFR="";
var finishedPhraseCount=0;

function showText (outputText, divElement, languageString) {
	let oldWords = (languageString=="de") ? currentTextDE.split(' ') : currentTextFR.split(' ');
	let finishedPhrases = (languageString=="de") ? finishedPhrasesDE : finishedPhrasesFR;

	// Always capitalize first letter of first string
	outputText = outputText.charAt(0).toUpperCase() + outputText.slice(1);
	let newWords = outputText.split(' ');

	// Remove old text from element
	divElement.innerHTML = finishedPhrases;
	for (var i=0; i<newWords.length; i++) {
		let iSpan = document.createElement('span');
		iSpan.id = 'word-' + finishedPhraseCount + '-' + i;;
		iSpan.innerHTML = newWords[i] + '&nbsp;';
		if (oldWords[i]===newWords[i]) {
			// Word was there before
			// Create new unchanged span/word 
			iSpan.className = languageString + '-word-unchanged';
		} else {
			// Word is new or has changed
			// Create new span/word 
			iSpan.className = languageString + '-word-new';
		}
		// Append this span/word
		divElement.appendChild(iSpan);
	}	
	(languageString=="de") ? currentTextDE=outputText : currentTextFR=outputText;
}

function outputDE (newText) {
	console.log ("(client.js) DE: " + newText);
	showText (newText, document.getElementById('divDE'), 'de');
}

function outputFR (newText) {
	console.log ("(client.js) FR: " +newText.translations[0].text);
	showText (newText.translations[0].text, document.getElementById('divFR'), 'fr');
}

function saveFinishedPhrases () {
	console.log ('(client.js) Saving finished phrases');
	// Call output functions to make all words unchanged
	showText (currentTextDE, document.getElementById('divDE'), 'de');
	showText (currentTextFR, document.getElementById('divFR'), 'fr');
	// Increase phrase count
	finishedPhraseCount++;
	// Add line break to outputs
	document.getElementById('divDE').innerHTML+='<BR>';
	document.getElementById('divFR').innerHTML+='<BR>';
	// Save finished phrases
	finishedPhrasesDE = document.getElementById('divDE').innerHTML;
	finishedPhrasesFR = document.getElementById('divFR').innerHTML;
	// Clear current phrase
	currentTextDE="";
	currentTextFR="";
}

function termsOfUse()
{
	showText(touText, document.getElementById("divDE"), 'de');
	document.getElementById("divTermsOfUse").style.display = "none";
}

//====== SOCKET TO NODE SERVER (client.js) ======

const socket = io.connect (nodeURL, {
  transports: ['websocket']
});

socket.on('connect', function (data) {
	console.log ('(client.js) Connected using ' + googleAgent);
	socket.emit('googleAgent', googleAgent);
});

// on reconnection, reset the transports option, as the Websocket
// connection may have failed (caused by proxy, firewall, browser, ...)
socket.on('reconnect_attempt', () => {
	console.log ('(client.js) Attemping to reconnect using "polling" and "websocket"');
	socket.io.opts.transports = ['polling', 'websocket'];
});

socket.on('message', message => {
	console.log(`(client.js) ${message}`);
});

socket.on('streamClosed', dummyValue => {
	console.log(`(client.js) Backend has closed the stream. Restarting a new one.`);
	isRecording=false;
	saveFinishedPhrases();
	closeMediaStream();
	setRecState();
});

socket.on('googleError', err => {
	console.log('(client.js) ERROR Code :' + err.code + ' / Msg: ' + err.message);
	if (err.code===11)
	{
		alert ('Google Cloud has disconnected :-(');
	}
});

socket.on('speechData', data => {
	let recognitionResult = data.results[0].alternatives[0];
	if (!recognitionResult.isFinal) {
		// Got interim data from Google DialogFlow Streaming Recognition
		let interimString = recognitionResult.transcript.replace(/\u00df/g, "ss"); // replace "ß" > "ss"
		outputDE (interimString);
	} else {
		// Got final data from Google DialogFlow Streaming Recognition
		let finalString = recognitionResult.transcript.replace(/\u00df/g, "ss"); // replace "ß" > "ss"
		outputDE ("Final: " + finalString);
	}
});

socket.on('translationFR', translationJSON => {
	outputFR (JSON.parse(translationJSON));
});

//============ PLAY BUTTON (START) ============
function playBtnClick () {
	
	// Show recording icon instead of play button
	//document.getElementById("divPlay").style.display = "none";
	document.getElementById("imagePlay").src="images/recording.gif";
	// document.getElementById("divTermsOfUse").style.display = "none";
	clearInput();
	setRecState();
}

function createMediaStream () {
	// Permission to access mic will be asked for here (first time)
	if (navigator.mediaDevices) {
		navigator.mediaDevices.getUserMedia(constraints)
		.then(handleMediaStream)
		.catch(function(err) {	
			console.error ("(client.js) Error on mediaDevices.getUserMedia: " + err.message);
			let errorMsg="<P><P><I>"+"Error on mediaDevices.getUserMedia: " + err.message +"</I>";
			showCriticalError (errorMsg);
		})
	} else {
		console.error('(client.js) NO SUPPORT for mediaDevices');
		showError("NO SUPPORT for mediaDevices");
	}
	
}

function closeMediaStream() {
	// End Google Cloud Stream, disconnect audio node chain and close audio context
	socket.emit('endGoogleCloudStream', '');

	input.disconnect (processor);
	//input.disconnect (audioContext.destination);
	processor.disconnect (audioContext.destination);
	mediaStream.getTracks().forEach(function(track) {
		track.stop();
	  });	
	input=null;
	mediaStream=null;
	showError ("Audio node chain stopped");

	closeAudioContext();
}

function createAudioContext () {
	// FIXME: Old stuff for Safari
	return new ( window.AudioContext || window.webkitAudioContext )();	
}

function closeAudioContext () {
	audioContext.close()
	.then (function (x) {
		showError ("audioContext closed");
	})
}

var handleMediaStream = function (stream) {
	mediaStream=stream;
	console.log ('(client.js) mediaStream created');
	showError ("mediaStream created");

	var ac;

	audioContext = createAudioContext();

	// Send actual sample rate in Hz for this client to backend (client.js)
	console.log(`(client.js) Sending AudioContext sample rate to backend: ${audioContext.sampleRate} Hz`);
	socket.emit('setSampleRateHertz', audioContext.sampleRate);
	showError ("audioContext state is: " + audioContext.state + ", " + audioContext.sampleRate + " Hz");

	// Start Google Cloud Stream
	// Sample rate needs to be available in backend here
	socket.emit('startGoogleCloudStream', '');
	showError ("startGoogleCloudStream");

	ac = audioContext.resume().then(function(result) {
		
		// Input
		input = audioContext.createMediaStreamSource(stream);
	
		// Processor node
		processor = audioContext.createScriptProcessor(bufferSize, 1, 1);

		input.connect (processor);
		processor.connect (audioContext.destination);
		// Use this to play the microphone input to speakers - watch out for audio feedback!
		//input.connect (audioContext.destination);
		showError ("Audio node chain created");
	
		//var receivedAudio = false;
		processor.onaudioprocess = function (e) {
			// Send binary data to client.js
			// This will be called multiple times per second.
			// The audio data will be in e.inputBuffer
			var left = e.inputBuffer.getChannelData(0);
			// Convert the buffer to Int16 using left channel only
			// Google best practice: no downsampling
			var left16 = convertFloat32ToInt16(left)
			// Audio stream will always be sent 16 bit, left channel only
			socket.emit('binaryAudioData', left16);
		};
	})

	Promise.all ([ac])
	.then (values => {
		// FIXME: debug code
		showError ("audioContext: " + audioContext.state);
	})
};


function pageLoaded(){
	document.getElementById("divPlay").style.display = "block";
	document.getElementById('divTermsOfUse').innerHTML = "Nutzungsbedingungen";
	document.getElementById("divTermsOfUse").style.display = "block";
};

//=============== RECORDING ===============


function setRecState() {
	// Recording state, createMediaStream
	isRecording = true;

	// This will create an audio context, an audio node chain and start the Google Cloud Stream
	createMediaStream();

	showError ("Rec state");
}

//=============== CLEANUP AND END ================

window.onbeforeunload = function () {
	closeMediaStream();
	socket.emit('endGoogleCloudStream', '');
};

//================= AUDIO HELPERS =================

function convertFloat32ToInt16(buffer) {
	let l = buffer.length;  //Buffer
	let buf = new Int16Array(l);
	let min = 0, 
		max = 0;
  
	while (l--) {
		buf[l] = buffer[l]*0x7FFF;
		if (min>buf[l]) {min=buf[l]};
		if (max<buf[l]) {max=buf[l]};
	}
	return buf.buffer;
}

//================= ERROR MESSAGES ================
function showError (errorMsg) {
	//document.getElementById('divError').innerHTML += errorMsg + "<BR>";
	//document.getElementById("divError").style.display = "block";
}

function showCriticalError (errorMsg) {
	document.getElementById('divError').innerHTML = criticalErrorMsg + errorMsg;
	document.getElementById("divError").style.display = "block";
	// Hide all other elements
	document.getElementById("divPlay").style.display = "none";
	document.getElementById("divDE").style.display = "none";
	document.getElementById("divFR").style.display = "none";
	
}

//================= OTHER HELPERS =================

// Function to convert application server key (webpush)
function urlBase64ToUint8Array(base64String) {
	const padding = '='.repeat((4 - base64String.length % 4) % 4);
	const base64 = (base64String + padding)
		.replace(/\-/g, '+')
		.replace(/_/g, '/');
	const rawData = window.atob(base64);
	return Uint8Array.from([...rawData].map((char) => char.charCodeAt(0)));
}
