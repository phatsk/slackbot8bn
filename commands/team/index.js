import express from 'express';
import * as logger from 'winston';
import config from '../../config';
import {urlSafeToken} from '../../lib/token';
import path from 'path';
import {ObjectID} from 'mongodb';
import { range, padStart } from 'lodash';

import * as db from '../../lib/db';
import * as slack from '../../lib/slack';
import moment from 'moment-timezone';

/**
 * 
 */

const COOKIE_NAME = '8bn-team';
export const router = express.Router();

export const command = '/team';
export async function handler(payload) {

    // create a new token for accessing the team page
    // and return the link to the user

    const token = await urlSafeToken(32);
    const url = `http://${payload.req.headers.host}/team/auth/${token}`

    const u = await slack.userInfo(payload.user_id);
    if(!u.ok) {
        logger.error('failed to get userInfo for: ', payload.user_id);
        return({
            "response_type": "ephemeral",
            text: `Oops, we were not able to determine who you are...`
        });
    }

    logger.debug(`creating token for ${u.user.name} [${u.user.id}]`);

    // update/insert the user
    const userUpdate = await db.team.users.updateOne(
        { _id: u.user.id }, 
        {$set: {name: u.user.name}},
        {upsert:true}
    );

    if(!userUpdate.result.ok) {
        logger.error('failed to update user: ', userUpdate);
        return({
            "response_type": "ephemeral",
            text: `Oops, we were not able to update the user cache...`
        });        
    }

    const insert = await db.team.tokens.insertOne({
        user: payload.user_id,
        channel: payload.channel_id,
        token: token,
        tz: u.user.tz,
        tz_offset: u.user.tz_offset,
        expire: Date.now() + 900000
    });

    // check if the insert worked?
    if(!insert.result.ok) {
        logger.error('failed to create token: ', insert);
        return({
            "response_type": "ephemeral",
            text: `Oops, we were not able to create a token...`
        });
    }

    return({
        "response_type": "ephemeral",
        text: `<${url}|Please use this link to review the 8bn events>`
    });
    
}

if(config.debug) {
    router.get('/auth', async function(req, res) {
        const tc = await db.team.tokens.find({});
        const tokens = [];
        while(await tc.hasNext()) {
            var t = await tc.next();
            tokens.push( {
                user: t.user,
                channel: t.channel,
                token: t.token,
                url: `http://${req.headers.host}/team/auth/${t.token}`
            });
        }
        res.json(tokens);
    });
}

// authenticate session and create cookie
router.get('/auth/:token', async function(req, res) {

    try {

        logger.debug(`${req.method} ${req.url}: looking up token: ${req.params.token}`);
        const token = await db.team.tokens.findOne({token : req.params.token});

        
        if(!token || token.expire < Date.now()) {
            // don't expire tokens for now
            //return res.status(410).send('Token Expired');
        }

        res.cookie(COOKIE_NAME, req.params.token, { path: '/team' });
        return res.redirect('..');

    } catch(err) {
        logger.error(err);
        if(!res.headersSent)
            res.status(500).send('Ooops, something went horribly wrong..');
    }
    
});

// events REST

// list all events - this is not really a REST style interface
// as it's basically helping to offload all the client side
// ETL to the server
router.get('/events', async function(req, res) {

    try {
        const auth = req.headers['authorization'];
        logger.debug(`${req.method} ${req.url}: auth: ${auth}`);

        if(!auth) {
            return res.status(403).json({ status: 'authorization missing'});
        }

        const token = await db.team.tokens.findOne({token : auth});

        if(!token) {
            logger.debug(`${req.method} ${req.url}: failed to find token for: ${auth}`);
            return res.status(403).json({ status: 'session expired' });
        }

        // get a list of subscribed channels for this user
        // generate a list of events filtered by channels
        // db.team.events.find()
        const users = {};
        const uc = await db.team.users.find();
        while(await uc.hasNext()) {
            var u = await uc.next();
            users[u._id] = u.name;
        }

        const sc = await slack.channels();
        if(!sc.ok) {
            logger.error("unable to get channel details from slack")
            return res.status(500).json({ status: 'failed to get channel details from slack' });
        }
        logger.debug(`found ${sc.channels.length} slack channels`);
        
        const channels = {};
        sc.channels.forEach((c) => {
            if(config.teamChannels.includes(c.name) 
                && c.members.length 
                && c.members.includes(token.user)) {

                channels[c.id] = { 
                    visible: c.id === token.channel, 
                    id: c.id, 
                    name: c.name, 
                    events: []
                };
            }

        });



        const events = await db.team.events.find().toArray();
        events.sort((a, b) => a.timestamp - b.timestamp);
        events.forEach((e) => {

            // add event to the channel
            if(channels[e.channel]) {
                channels[e.channel].events.push({
                    id: e._id,
                    name: e.name,
                    date: moment(e.timestamp).tz(token.tz).format('llll'),
                    canJoin: !e.alternates.concat(e.participants).
                            includes(token.user),
                    visible: false,
                    participants: e.participants.map( (u) => ({
                        id: u,
                        name: users[u],
                        canLeave: u === token.user,
                    }) ),
                    alternates: e.alternates.map( (u) => ({
                        id: u,
                        name: users[u],
                        canLeave: u === token.user,
                    }) )
                });
            }
        });

        const now = moment().tz(token.tz);
        const datePicker = {
            
            now: {
                // get the closest 15 min period
                minutes: padStart((parseInt(now.minutes()/15, 10) * 15) % 60, 2, '0'),
                hour: now.hour() % 12,
                period: now.format('A')
            },
            // determine the next 14 days from today in the locale
            // of the user
            dates: range(0, 14).map( (d) => ({
                value: now.add(d ? 1 : 0, 'd').format('YYYY-MM-DD'),
                text: now.format('ddd Do MMM YYYY')
            }) ),
            hours: range(1, 13),
            minutes: range(0, 60, 15).map( (m) => padStart(m, 2, '0'))
        };
        
        return res.json({
            'status': 'ok',
            token: { 
                channel: token.channel, 
                user: token.user  
            },
            datePicker: datePicker,
            //users: users,
            //events: events,
            // sort the channels into locale alphabetical order
            channels: Object.values(channels).
                    sort((a, b) => a.name.localeCompare(b.name) )

        });

    } catch(err) {
        logger.error(err);
        if(!res.headerSent)
            res.status(500).json({ status: 'internal error' });
    }

});

// create a new event
router.post('/events', async function(req, res) {

    try {
        logger.debug(req.body);
        const auth = req.headers['authorization'];
        logger.debug(`${req.method} ${req.url}: auth: ${auth}`);

        if(!auth) {
            return res.status(403).json({ status: 'authorization missing'});
        }

        const token = await db.team.tokens.findOne({token : auth});

        if(!token) {
            logger.debug(`${req.method} ${req.url}: failed to find token for: ${auth}`);
            return res.status(403).json({ status: 'session expired' });
        }

        const {
            event
        } = (req.body || {});

        // check everything exists?
        if(!event.name || !event.date || !event.hour || 
            !event.channel ||
           !event.minutes || !event.period ) {
            return res.status(400).json({ status: 'malformed event' });
        }

        const timestamp = moment.tz(event.date + padStart(event.hour, 2, '0') + 
                  event.minutes + event.period, 
                  'YYYY-MM-DDhhmmA', token.tz);

        const newEvent = await db.team.events.insertOne({
            owner: token.user,
            channel: event.channel,
            name: event.name,
            timestamp: timestamp.valueOf(),
            participants: [ token.user ],
            alternates: [ ]
        });

        if(newEvent.result.ok) {

            res.json({ status: 'ok', result: newEvent.result, id : newEvent.insertedId});
            //const event = newEvent.value;
            //const timestamp = moment(event.timestamp);
            const fallbackTime = timestamp.utc().format('llll') + " UTC";
            // send back a message to the channel
            const attachment = {
                "fallback": `<@${token.user}> has created ${event.name}`,
                "color": "#36a64f",
                "title": `<@${token.user}> has created ${event.name}`,
                "fields": [
                    {
                        "value": `<!date^${timestamp.unix()}^{date_short_pretty} {time}|${fallbackTime}>`
                    },
                    {
                        "title": "Participants",
                        "value": "1", // need to show the number of spaces
                        "short": true
                    },
                    {
                        "title": "Alternates",
                        "value": "0",
                        "short": true
                    }
                ]
            };
            const post = await slack.postMessage(event.channel, undefined,
                { as_user: true,
                    attachments: [
                        attachment
                    ]
                }
            );
            logger.debug(post);
            return;
        } else {
            return res.status(500).json({ status: 'failed to create event', result: newEvent.result });
        }
        //logger.debug(event.insertedId);

        

    } catch(err) {
        logger.error(err);
        if(!res.headersSent)
            res.status(500).json({ status: 'internal error' });
    }
});

// replace (i.e. update) the event
router.put('/events/:id', async function(req, res) {
    try {
        logger.debug(req.body);

        const auth = req.headers['authorization'];
        logger.debug(`${req.method} ${req.url}: auth: ${auth}`);

        if(!auth) {
            return res.status(403).json({ status: 'authorization missing'});
        }

        const token = await db.team.tokens.findOne({token : auth});

        if(!token) {
            logger.debug(`${req.method} ${req.url}: failed to find token for: ${auth}`);
            return res.status(403).json({ status: 'session expired' });
        }

        const event_id = new ObjectID(req.params.id);
        logger.debug('updating event: ',event_id.valueOf());
        
        const update = await db.team.events.updateOne({_id: event_id}, {
            $set: {
                name: req.body.name,
                timestamp: req.body.timestamp,
                participants: req.body.participants,
                alternates: req.body.alternates
            }
        });

        logger.debug(update.result);

        return res.json({ status: 'ok', result: update.result});

    } catch(err) {
        logger.error(err);
        if(!res.headersSent)
            res.status(500).json({ status: 'internal error' });
    }
});


router.post('/events/:id/join', async function(req, res) {
    try {
        logger.debug(req.body);
        
        const auth = req.headers['authorization'];
        logger.debug(`${req.method} ${req.url}: auth: ${auth}`);

        if(!auth) {
            return res.status(403).json({ status: 'authorization missing'});
        }

        const token = await db.team.tokens.findOne({token : auth});

        if(!token) {
            logger.debug(`${req.method} ${req.url}: failed to find token for: ${auth}`);
            return res.status(403).json({ status: 'session expired' });
        }

        if(!req.body.type) {
            return res.status(400).json( { status: 'malformed request' } );
        }

        const event_id = new ObjectID(req.params.id);
        logger.debug('user: '+token.user+', is joining event: '+event_id.valueOf());

        const addToSet = {};

        const update = await db.team.events.findOneAndUpdate({_id: event_id}, {
            $push: (req.body.type === 'participant') ? {
                participants: token.user 
            } : {
                alternates: token.user
            }
        },{ returnOriginal: false });

        if(update.ok) {

            res.json({ status: 'ok', result: update.lastErrorObject});
            const event = update.value;
            const timestamp = moment(event.timestamp);
            const fallbackTime = timestamp.utc().format('llll') + " UTC";
            // send back a message to the channel
            const attachment = {
                "fallback": `<@${token.user}> has joined ${event.name}`,
                "color": "#36a64f",
                "title": `<@${token.user}> has joined ${event.name}`,
                "fields": [
                    {
                        "value": `<!date^${timestamp.unix()}^{date_short_pretty} {time}|${fallbackTime}>`
                    },
                    {
                        "title": "Participants",
                        "value": `${event.participants.length}`,
                        "short": true
                    },
                    {
                        "title": "Alternates",
                        "value": `${event.alternates.length}`,
                        "short": true
                    }
                ]
            };
            const post = await slack.postMessage(update.value.channel, undefined,
                { as_user: true,
                    attachments: [
                        attachment
                    ]
                }
            );
            logger.debug(post);
            return;
        } else {
            return res.status(500).json({ status: 'failed to join event', result: update.lastErrorObject });
        }

    } catch(err) {
        logger.error(err);
        if(!res.headersSent)
            res.status(500).json({ status: 'internal error' });
    }
});

router.get('/events/:id/leave', async function(req, res) {
    try {
        
        const auth = req.headers['authorization'];
        logger.debug(`${req.method} ${req.url}: auth: ${auth}`);

        if(!auth) {
            return res.status(403).json({ status: 'authorization missing'});
        }

        const token = await db.team.tokens.findOne({token : auth});

        if(!token) {
            logger.debug(`${req.method} ${req.url}: failed to find token for: ${auth}`);
            return res.status(403).json({ status: 'session expired' });
        }

        const event_id = new ObjectID(req.params.id);
        logger.debug('user: '+token.user+', is leaving event: '+event_id.valueOf());

        // brute force leave
        const update = await db.team.events.findOneAndUpdate({_id: event_id}, {
            $pull: { participants: token.user, alternates: token.user }
        },
        { returnOriginal: false });

        if(update.ok) {

            res.json({ status: 'ok', result: update.lastErrorObject });
            const event = update.value;
            const timestamp = moment(event.timestamp);
            const fallbackTime = timestamp.utc().format('llll') + " UTC";
            // send back a message to the channel
            const attachment = {
                "fallback": `<@${token.user}> has left ${event.name}`,
                "color": "#36a64f",
                "title": `<@${token.user}> has left ${event.name}`,
                "fields": [
                    {
                        "value": `<!date^${timestamp.unix()}^{date_short_pretty} {time}|${fallbackTime}>`
                    },
                    {
                        "title": "Participants",
                        "value": `${event.participants.length}`,
                        "short": true
                    },
                    {
                        "title": "Alternates",
                        "value": `${event.alternates.length}`,
                        "short": true
                    }
                ]
            };
            const post = await slack.postMessage(update.value.channel, undefined,
                { as_user: true,
                    attachments: [
                        attachment
                    ]
                }
            );
            logger.debug(post);
            return;
        } else {
            return res.status(500).json({ status: 'failed to leave event', result: update.lastErrorObject });
        }        

    } catch(err) {
        logger.error(err);
        if(!res.headersSent)
            res.status(500).json({ status: 'internal error' });
    }
});

// remove the event
router.delete('/events/:id', async function(req, res) {

});

//serve up static files
router.use('/', express.static(path.join(__dirname, 'public')));
