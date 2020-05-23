const api_base = 'https://sigtor.org/v1/events';
const poll_delay_ms = 60 * 1000;
const minute_in_us = 1 * 60 * 1000 * 1000;
const hour_in_us = 60 * minute_in_us;
const day_in_us = 24 * hour_in_us;
const distance_filter_miles = 120;
const event_retention_in_us = 3 * hour_in_us;
const ls_config_items_key = 'sware-config-items';
const ls_config_key = 'sware-config_v2';    // NOTE: Bump version if config schema ever changes
const sev_hail_threshold = 2.0;
const gps_decimal_precision = 3;
const tor_related_hazards = ['Tornado', 'WallCloud', 'Funnel'];
const filterableSources = ['NwsAfd', 'NwsFfw', 'NwsFlw', 'NwsLsr', 'NwsSvr', 'NwsTor', 'SnReport'];

// Elements
const dialog_content_el = document.getElementById('dialog-content');

// Alert blurbs
const tor_emergency_blurb = "The National Weather Service has issued a Tornado Emergency.";
const new_watch_blurb = "The Storm Prediction Center has issued a new $PDS $WATCHTYPE watch for $PLACE.";
const new_md_blurb = "The Storm Prediction Center has issued mesoscale discussion $NUMBER $PROBABILITY.";
const new_outlook_blurb = "The Storm Prediction Center has issued a new Day 1 outlook, $RISK.";
const sev_hail_blurb = "$MAG inch severe hail has been reported $PLACE.";
const tor_blurb = "A tornado has been reported $PLACE by $REPORTER.";
const tor_warning_blurb = "The National Weather Service has issued a $PDS Tornado Warning for: $PLACE";
const svs_blurb = "The National Weather Service has issued a PDS severe weather statement.";

let last_ts = 0;
let geo_location = {};

const toRad = x => (x * Math.PI) / 180;
// The values used for the radius of the Earth (3961 miles & 6373 km) are optimized for locations around 39 degrees from the equator
const R = 3961;

/**
 * Returns the distance in miles between two points
 * @param {*} current_location 
 * @param {*} point 
 */
const get_distance = (point1, point2) => {
    const l1Rad = toRad(point1.lat);
    const l2Rad = toRad(point2.lat);
    const dLat = toRad(point2.lat - point1.lat);
    const dLon = toRad(point2.lon - point1.lon);
    const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
            Math.cos(l1Rad) * Math.cos(l2Rad) *
            Math.sin(dLon/2) * Math.sin(dLon/2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    const d = R * c;
    return Math.floor(d);
}

// Converts from degrees to radians.
function toRadians(degrees) {
    return degrees * Math.PI / 180;
};
   
// Converts from radians to degrees.
function toDegrees(radians) {
    return radians * 180 / Math.PI;
}
  
const get_bearing = (point1, point2) => {
    const startLat = toRadians(point1.lat);
    const startLng = toRadians(point1.lon);
    const destLat = toRadians(point2.lat);
    const destLng = toRadians(point2.lon);
    const y = Math.sin(destLng - startLng) * Math.cos(destLat);
    const x = Math.cos(startLat) * Math.sin(destLat) - Math.sin(startLat) * Math.cos(destLat) * Math.cos(destLng - startLng);
    const brng = Math.atan2(y, x);
    const brng_deg = toDegrees(brng);
    const final_bearing = (brng_deg + 180) % 360;
    return get_cardinal_direction(final_bearing);
}

/**
 * Returns an array of display abbreviation, full name
 * @param {number} bearing 
 */
const get_cardinal_direction = (bearing) => {
    if (bearing >= 22.5 && bearing < 47.5) {
        return ['SW', 'southwest']
    } else if (bearing >= 47.5 && bearing < 112.5) {
        return ['W', 'west']
    } else if (bearing >= 112.5 && bearing < 157.5) {
        return ['NW', 'northwest']
    } else if (bearing >= 157.5 && bearing < 202.5) {
        return ['N', 'northwest']
    } else if (bearing >= 202.5 && bearing < 247.5) {
        return ['NE', 'northeast']
    } else if (bearing >= 247.5 && bearing < 292.5) {
        return ['E', 'east']
    } else if (bearing >= 292.5 && bearing < 337.5) {
        return ['SE', 'southeast']
    } else {
        // It must be South, which we left for last because it wraps after 360
        return ['S', 'south']
    }
}

const is_point_in_bounds = (point, bounds) => {
    return (point.lat >= bounds.min_lat && point.lat <= bounds.max_lat &&
        point.lon >= bounds.min_lon && point.lon <= bounds.max_lon);
}

const poly_to_bounds = (poly) => {
    let min_lat = poly[0].lat;
    let min_lon = poly[0].lon;
    let max_lat = poly[0].lat;
    let max_lon = poly[0].lon;

    poly.forEach(x => {
        if (x.lat < min_lat) {
            min_lat = x.lat;
        }
        if (x.lon > min_lon) {
            min_lon = x.lon;
        }
        if (x.lat > max_lat) {
            max_lat = x.lat;
        }
        if (x.lon < max_lon) {
            max_lon = x.lon;
        }
    });

    return {
        min_lat,
        min_lon,
        max_lat,
        max_lon,
    };
}

const fetchUrl = (url) => fetch(url)
  .then(function(response) {
    return response.json();
  })
  .then(function(events) {
    const preparedEvents = events.map(prepareEvent);
    if (preparedEvents[0]) {
        last_ts = preparedEvents[preparedEvents.length - 1].ingest_ts;
        app.events = app.events.concat(preparedEvents);
    }
    processEvents();
  });

// GPS timer
const geo_options = {
    enableHighAccuracy: true,
    timeout: 10000,
    maximumAge: 0
};

function geo_success(pos) {
    app.location = { lat: pos.coords.latitude, lon: pos.coords.longitude };
    set_location_status();
}

function geo_failure(e) {
    app.location = {};
    set_location_status();
    console.warn(e);
}

function get_location() {
    const isManualConfig = app.config_items.find(x => x.id === 'gpsLocation').toggled;
    if (!isManualConfig) {
        navigator.geolocation.getCurrentPosition(geo_success, geo_failure, geo_options);
    }
}

setInterval(() => {
    get_location();
}, 10000);

function set_location_status() {
    const isManualConfig = app.config_items.find(x => x.id === 'gpsLocation').toggled;

    if (isManualConfig) {
        app.location_status = 'Manual';
    } else {
        const location = get_current_location();
        if (!isNaN(location.lat) && !isNaN(location.lon)) {
            app.location_status = `${location.lat.toFixed(gps_decimal_precision)}, ${location.lon.toFixed(gps_decimal_precision)}`;
        } else {
            location_status = 'Waiting for GPS...';
        }
    }
}

// Clock timer
setInterval(() => {
    app.clock = get_clock();
}, 1000);

const get_clock = () => {
    const dt = new Date();
    return `${pad_zero(dt.getUTCHours())}${pad_zero(dt.getUTCMinutes())}Z`;
}

// Stateless decorations to incoming events
const prepareEvent = (event) => {
    const derived = {};
    const then = new Date(event.event_ts / 1000);
    const parsed_dt = `${pad_zero(then.getUTCHours())}${pad_zero(then.getUTCMinutes())}Z`;

    derived.is_important = get_importance(event);
    derived.is_tor_related = is_tor_related(event);
    derived.parsed_dt = parsed_dt;
    derived.link = get_link(event);

    if (event.location && event.location.poly) {
        const bounds = poly_to_bounds(event.location.poly);
        derived.point = get_center_simple(event.location.poly);
        derived.bounds = bounds;

        // Half of the diagonal is as close to a "radius" as we're likely to get in an easy way
        const half_edge_distance = get_distance(
            { lat: bounds.min_lat, lon: bounds.min_lon },
            { lat: bounds.max_lat, lon: bounds.max_lon }
        ) / 2;

        derived.half_edge_distance = half_edge_distance;
    }
    
    event.derived = derived;

    return event;
}

const get_link = event => {
    if (event.event_type === 'NwsSel') {
        let id = `${event.watch.id}`;

        if (id.length === 1) {
            id = `000${id}`;
        } else if (id.length === 2) {
            id = `00${id}`;
        } else if (id.length === 3) {
            id = `0${id}`;
        }
        
        return `https://www.spc.noaa.gov/products/watch/ww${id}.html`;
    } else if (event.event_type === 'NwsSwo' && event.md) {
        let id = `${event.md.id}`;
        let year = (new Date(event.event_ts / 1000)).getUTCFullYear()

        if (id.length === 1) {
            id = `000${id}`;
        } else if (id.length === 2) {
            id = `00${id}`;
        } else if (id.length === 3) {
            id = `0${id}`;
        }
        
        return `https://www.spc.noaa.gov/products/md/${year}/md${id}.html`;
    }

    return;
}

/**
 * Whether or not an event should be considered for alerting or display
 * @param {*} event 
 * @param {*} current_location 
 */
const filterEvent = (event, current_location) => {
    // Distance filter
    const is_distance_filter = app.config_items.find(x => x.id === 'distanceFilter').toggled;

    if (is_distance_filter && filterableSources.indexOf(event.event_type) > -1) {
        if (event.location && event.location.point) {
            const distance = get_distance(current_location, event.location.point);
            if (distance > distance_filter_miles) {
                return false;
            }
        } else if (event.derived.point && event.derived.half_edge_distance) {
            const distance = get_distance(current_location, event.derived.point);
            if (distance > distance_filter_miles + event.derived.half_edge_distance) {
                return false;
            }
        }
    }

    // AFD filters
    const filter_afds = app.config_items.find(x => x.id === 'hideAfds').toggled;
    if (filter_afds && event.event_type === 'NwsAfd') {
        return false;
    }

    // Minor Reports filter
    const filter_minor = app.config_items.find(x => x.id === 'hideMinorReports').toggled;
    if (filter_minor && (event.event_type === 'NwsLsr' || event.event_type === 'SnReport')) {
        return (event.report.hazard === 'Tornado' || event.report.hazard === 'Funnel' ||
            event.report.hazard === 'WallCloud' || event.report.hazard === 'FlashFlood' ||
            ((event.report.hazard === 'Hail') && event.report.magnitude >= 1.75) ||
            (event.report.hazard === 'Wind' && event.report.magnitude >= 70))
    }

    return true;
}

// Stateful decorations to all events
const massageEvent = (event, current_location) => {
    const now = Date.now() * 1000;  // Convert from ms to us
    event.derived.time_ago = get_time_ago(now, event.ingest_ts);

    // Conditional derivations
    if (current_location && event.location && event.location.point) {
        const distance = get_distance(current_location, event.location.point);
        const bearing = get_bearing(current_location, event.location.point);
        if (!isNaN(distance)) {
            event.derived.distance = distance;
            event.derived.bearing = bearing[1];
            event.derived.distance_label = `${distance}mi ${bearing[0]}`;
        }
    }

    return event;
};

const is_tor_related = (event) => {
    if (event.report && tor_related_hazards.indexOf(event.report.hazard) > -1) {
        return true;
    } else if (event.event_type === 'NwsTor') {
        return true;
    } else if (event.event_type === 'NwsSvs') {
        return true;
    } else if (event.event_type === 'NwsSel' && event.watch && event.watch.watch_type === 'Tornado') {
        return true;
    }

    return false;
}

const get_current_location = () => {
    const manualConfig = app.config_items.find(x => x.id === 'gpsLocation');
    if (manualConfig.toggled && !isNaN(app.config.manualLat) && !isNaN(app.config.manualLon)) {
        return { lat: app.config.manualLat, lon: app.config.manualLon };
    } else {
        return app.location;
    }
}

const buildAlertForEvent = (event, current_location) => {
    if (event.seen) {
        return event;
    } else {
        event.seen = true;
    }

    // Check filters and early exit without alerting if not an event the user cares about.
    if (!filterEvent(event, current_location)) {
        return event;
    }

    let alert;
    let use_eas = false;

    if (event.report) {
        if (event.report.hazard === 'Tornado') {
            alert = tor_blurb.replace('$REPORTER', event.report.reporter)
            // SN won't have this, but LSRs will
            const place = event.location.county ? `for ${event.location.county} county.` : '';
            alert = alert.replace('$PLACE', place);
            if (event.report.is_tor_emergency) {
                alert += tor_emergency_blurb;
            }
        } else if (event.report.hazard === 'Hail' && event.report.magnitude && event.report.magnitude >= sev_hail_threshold) {
            alert = sev_hail_blurb
                .replace('$MAG', event.report.magnitude)
                .replace('$PLACE', event.location.county
                    ? `for ${event.location.county} county.`
                    : '');
        }
    } else if (event.outlook && event.outlook.swo_type === 'Day1') {
        alert = new_outlook_blurb.replace('$RISK', getRiskWords(event.outlook.max_risk));
    } else if (event.md && event.md.concerning.indexOf('New') === 0) {
        probability = event.md.watch_issuance_probability
            ? `with ${event.md.watch_issuance_probability}% watch chance`
            : '';
        alert = new_md_blurb
            .replace('$NUMBER', event.md.id)
            .replace('$PROBABILITY', probability);
    } else if (event.event_type === 'NwsTor') {
        alert = tor_warning_blurb
            .replace('$PLACE', event.warning.issued_for)
            .replace('$PDS', event.warning.is_pds ? 'PDS' : '');
    } else if (event.watch && event.watch.status === 'Issued') {
        use_eas = true;
        alert = new_watch_blurb
            .replace('$PDS', event.watch.is_pds ? 'PDS' : '')
            .replace('$WATCHTYPE', event.watch.watch_type)
            .replace('$PLACE', event.watch.issued_for);
    } else if (event.event_type === 'NwsSvs') {
        use_eas = true;
        alert = svs_blurb;
    }

    if (alert) {
        if (use_eas) {
            queueAlert('eas');
        }

        // TODO gross - figure out a better way
        if (event.derived.distance && event.derived.bearing) {
            const blurb = `${event.derived.distance} miles to the ${event.derived.bearing}`;
            queueAlert([alert, blurb]);
        } else {
            queueAlert([alert]);
        }
    }

    return event;
}

function getRiskWords(risk) {
    switch (risk) {
        case 'MRGL':
            return 'there is a Marginal Risk of severe thunderstorms';
        case 'SLGT':
            return 'there is a Slight Risk of severe thunderstorms';
        case 'ENH':
            return 'there is an Enhanced Risk of severe thunderstorms';
        case 'MDT':
            return 'there is a Moderate Risk of severe thunderstorms';
        case 'HIGH':
            return 'there is a High Risk of severe thunderstorms';
        default:
            return '';
    }
}

const processEvents = () => {
    const current_location = get_current_location();
    const truncatedEvents = truncateEvents(app.events);
    const massagedEvents = truncatedEvents.map(x => massageEvent(x, current_location));
    const alertedEvents = massagedEvents.map(x => buildAlertForEvent(x, current_location));
    app.events = alertedEvents
    app.displayEvents = app.events
        .filter(x => filterEvent(x, current_location))
        .reverse();
}

const truncateEvents = (events) => {
    const now = Date.now() * 1000;  // ms to us
    const retention_cutoff = now - event_retention_in_us;
    let truncate_at_index = null;

    for (let i = 0; i < events.length; i++) {
        if (events[i].ingest_ts < retention_cutoff) {
            truncate_at_index = i;
            break;
        }
    }

    return (truncate_at_index !== null)
        ? events.slice(0, truncate_at_index)
        : events;
}

const get_importance = (event) => {
    let is_important = false;

    if (event.event_type === 'NwsSwo') {
        if (event.md && event.md.concerning.indexOf('New') === 0) {
            is_important = true;
        } else if (event.outlook && event.outlook.swo_type === 'Day1') {
            is_important = true;
        }
    } else if (event.event_type === 'SnReport' || event.event_type === 'NwsLsr') {
        if (event.report.hazard === 'Tornado' || event.report.hazard === 'WallCloud') {
            is_important = true;
        }
        if (event.report.hazard === 'Hail' && event.report.magnitude && event.report.magnitude > sev_hail_threshold) {
            is_important = true;
        }
    } else if (event.event_type === 'NwsTor') {
        is_important = true;
    } else if (event.event_type === 'NwsSel' && event.watch && event.watch.status === 'Issued') {
        is_important = true;
    }

    return is_important;
}

const get_time_ago = (now, then) => {
    const delta = now - then;
    if (delta < minute_in_us) {
        return '<1m';
    } else if (delta < hour_in_us) {
        return `${Math.floor(delta / minute_in_us)}m`;
    } else if (delta < day_in_us) {
        return `${Math.floor(delta / hour_in_us)}h`;
    } else {
        return '1d+'
    }
}

// TODO take places as 2nd param and update the decorate_text function
const pad_zero = (input) => {
    if (!isNaN(input)) {
        const num = parseInt(input);
        if (num < 10 && num > -1) {
            return `0${input}`;
        }
    }

    return input;
}

const save_config = () => {
    try {
        localStorage.setItem(ls_config_key, JSON.stringify(app.config));
        localStorage.setItem(ls_config_items_key, JSON.stringify(app.config_items));
    } catch (ex) {
        console.error(`Error saving config: ${ex}`);
    }
};
  
const load_config = () => {
    try {
        const config = localStorage.getItem(ls_config_key);
        const config_items = localStorage.getItem(ls_config_items_key);
        
        if (config) {
            app.config = JSON.parse(config);

            if (config_items) {
                app.config_items = JSON.parse(config_items);
            }
        } else {
            console.log('No config for latest version found, clearing local storage.')
            localStorage.clear()
        }

        console.log('Loaded config.');
    } catch (ex) {
        console.error(`Error loading config: ${ex}`);
    }
};

/**
 * Does a simple and fast approximation of the center of a polygon. Do not use where
 * a precise centroid is required, especially for irregular polygons.
 */
const get_center_simple = (poly) => {
    let sum_lat = 0;
    let sum_lon = 0;

    poly.forEach(x => {
        sum_lat += x.lat;
        sum_lon += x.lon;
    });

    return {
        lat: sum_lat / poly.length,
        lon: sum_lon / poly.length,
    };
}

const app = new Vue({
    el: '#app',
    data: {
        events: [],
        displayEvents: [],
        config_items: [
            { id: "gpsLocation", text: "Manual Location", toggled: false },
            { id: "hideAfds", text: "Hide AFDs", toggled: false },
            { id: 'hideMinorReports', text: 'Hide Minor Reports', toggled: false },
            { id: "distanceFilter", text: "Distance Filter", toggled: false },
            { id: "audioAlerts", text: "Audio Alerts", toggled: true },
        ],
        config: {
            'manualLat': null,
            'manualLon': null,
        },
        location: {},
        location_status: 'Waiting for GPS...',
        clock: get_clock(),
        details_title: '',
        details_source: '',
        details_text: '',
        details_link: '',
        details_time: '',
        sidebar_active: false,
        details_active: false,
        intro_dialog_active: true
    },
    methods: {
        showEventDetails: function(event) {
            app.events.forEach(x => { x.derived.selected = false; } );
            event.derived.selected = true;
            this.details_source = `Source: ${event.event_type}`; // TODO get source from eventtype
            if (event.event_type === 'NwsAfd' && !event.text && event.ext_uri) {
                fetch(event.ext_uri).then(x => x.json()).then(x => {
                    if (x && x.productText) {
                        event.text1 = x.productText;
                        this.details_text = x.productText;
                    }
                });
            }
            this.details_title = event.title;
            this.details_text = event.text;
            this.details_link = event.derived.link;
            this.details_time = `Time: ${event.derived.parsed_dt}`;
            this.details_active = !this.details_active; // Needed for smaller views
        },
        toggleConfig: function(id) {
            const item = this.config_items.find(x => x.id === id);
            item.toggled = !item.toggled;
            if (item.id === 'gpsLocation') {
                set_location_status();
            }
        },
        toggleSidebar: function() {
            this.sidebar_active = !this.sidebar_active;

            if (!this.sidebar_active) {
                save_config();
                processEvents();
            }
        },
        hideDetails: function() {
            this.details_active = false;
        },
        acceptTerms: function() {
            this.intro_dialog_active = false;
            // It's necessary to play()/speak() for iOS Safari
            audioElement.play();
            synth.speak(new SpeechSynthesisUtterance(''));
            start_app();
        }
    }
});

const start_app = () => {
    load_config();
    set_location_status();
    let url = `${api_base}/${last_ts}`;
    fetchUrl(url);

    setInterval(() => {
        let url = `${api_base}/${last_ts}`;
        fetchUrl(url);
    }, poll_delay_ms);
}

// Audio
const audioElement = document.createElement('audio');
const synth = window.speechSynthesis;
const alert_config = app.config_items.find(x => x.id === 'audioAlerts');
let audioQueue = [];
let processing = false;

function processQueue() {
    processing = true;
    const queueItem = audioQueue[0];
  
    const queueCleanup = () => {
      if (audioQueue.length <= 1) {
        audioQueue = [];
        processing = false;
      } else {
        audioQueue = audioQueue.slice(1);
        setTimeout(processQueue, 2000);
      }
    };

    if (queueItem === 'eas') {
        audioElement.src = `assets/${queueItem}.mp3`;
        audioElement.onended = queueCleanup;
        audioElement.onerror = queueCleanup;
        audioElement.play();
    } else {
        queueItem[queueItem.length - 1].onend = queueCleanup;
        queueItem.forEach(x => synth.speak(x));
    }
}

function queueAlert(text) {
    if (!synth || !alert_config.toggled || !text) { return; }
  
    if (text === 'eas') {
        audioQueue.push(text);
    } else {
        // Note: Chrome speech synth stops working after 15 second utterances
        // https://bugs.chromium.org/p/chromium/issues/detail?id=335907
        const utterances = text.map(x => new SpeechSynthesisUtterance(x));
        audioQueue.push(utterances);
    }
  
    if (!processing) {
        processQueue();
    }
}

// INIT - vue app is available
