import { Room, Client, CloseCode } from 'colyseus';
import { GameRoomState } from './schema/GameRoomState.js';

export class GameRoom extends Room {
    maxClients = 4;
    state = new GameRoomState();

    messages = {
        yourMessageType: (client: Client, message: any) => {
            /**
             * Handle "yourMessageType" message.
             */
            console.log(client.sessionId, 'sent a message:', message);
        },
    };

    onCreate(options: any) {
        /**
         * Called when a new room is created.
         */
    }

    onJoin(client: Client, options: any) {
        /**
         * Called when a client joins the room.
         */
        console.log(client.sessionId, 'joined!');
    }

    onLeave(client: Client, code: CloseCode) {
        /**
         * Called when a client leaves the room.
         */
        console.log(client.sessionId, 'left!', code);
    }

    onDispose() {
        /**
         * Called when the room is disposed.
         */
        console.log('room', this.roomId, 'disposing...');
    }
}
