import React, { useEffect, useRef, useState } from 'react';
import "video-react/dist/video-react.css"; // import css
import logo from './logo.svg';
import './App.css';
import  {Player, PlayerReference} from 'video-react';
import q from 'qjuul';
import { withResizeDetector } from 'react-resize-detector';
import * as signalR from '@microsoft/signalr';
import * as qs from 'query-string'
import axios from 'axios';

interface IAppProps {
  width: number;
  height: number;
}

interface QueueItems {
  friendlyName: string
  value: string
  started: number
  type: string
  guildId: string
  fileType: string
}

function App({ width, height } : IAppProps) {
  const [realHeight, setRealHeight] = useState(height)
  const player = useRef<PlayerReference>()
  const [events, setEvents] = useState<Array<QueueItems>>([])
  const guildId = window.location.pathname.split('/')[window.location.pathname.split('/').length - 1]
  const [video, setVideo] = useState<string>()
  
  useEffect(() => {
    setTimeout(() => {
      setRealHeight(Math.random())
    }, 50);
    
  }, [height])

  const mounted = useRef(false)

  useEffect(() => {
    if (mounted.current) return;
    mounted.current = true

    axios.get("https://api.sindrema.com/api/Juky/watch/" + guildId).then(res => {
      setEvents(res.data)
    })



    var connection = new signalR.HubConnectionBuilder()
    .withUrl("https://api.sindrema.com/JukyHub")
    .configureLogging(signalR.LogLevel.Information)
    .build();

    async function start() {
      try {
          await connection.start();
          console.log("SignalR Connected.");
      } catch (err) {
          console.log(err);
          setTimeout(start, 5000);
      }
    };
    connection.onclose(async () => {
        await start();
    });
    connection.on(`eventadded`, ( data: QueueItems ) => {
      setEvents(events => [...events, data])      
    });

    // Start the connection.
    start();
  
  }, [])

  useEffect(() => {
    const data = events[events.length - 1]
    if (data?.guildId == guildId) {
      const lastItem = data
      if (lastItem) {
        if (lastItem.type == 'play') {
          const video = `https://stream.sindrema.com/${encodeURIComponent(lastItem.friendlyName)}${lastItem.fileType}`
          setVideo(video)
          player.current?.load()
          setTimeout(() => {
            console.log("eevent seek", (Date.now() - lastItem.started) / 1000);
            
            player.current?.seek((Date.now() - lastItem.started) / 1000)
            player.current?.play()  
            
          }, 10);
        } else if (lastItem.type == 'pause') {
          player.current?.pause()
        } else if (lastItem.type == 'resume') {
          player.current?.play()
        }
      }
    }
  }, [events])
  
  const startTime = (Date.now() - events[events.length -1]?.started) / 1000
  console.log({startTime});
  
  return (
    <q.div f1 w100 fccc >
      <q.div f1 w100 fctc>
        <Player
          ref={x=> player.current = x as any}
          width={width}          
          height={window.innerHeight}
          fluid={false}
          muted={true}
          playsInline
          startTime={startTime}
          src={video}
        />
      </q.div>
      
    </q.div>
  );
}

export default withResizeDetector(App);
