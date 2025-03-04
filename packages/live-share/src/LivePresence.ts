/*!
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the Microsoft Live Share SDK License.
 */

import { DataObject, DataObjectFactory } from "@fluidframework/aqueduct";
import { IEvent } from "@fluidframework/common-definitions";
import { LiveEventScope } from "./LiveEventScope";
import { LiveEventTarget } from "./LiveEventTarget";
import {
    LivePresenceUser,
    PresenceState,
    ILivePresenceEvent,
} from "./LivePresenceUser";
import { LiveObjectSynchronizer } from "./LiveObjectSynchronizer";
import { LiveTelemetryLogger } from "./LiveTelemetryLogger";
import { cloneValue, TelemetryEvents } from "./internals";
import { TimeInterval } from "./TimeInterval";
import { v4 } from "uuid";
import { LiveEvent } from "./LiveEvent";

/**
 * Events supported by `LivePresence` object.
 */
export enum LivePresenceEvents {
    /**
     * The presence for the local or a remote user has changed.
     */
    presenceChanged = "presenceChanged",
}

/**
 * Event typings for `LivePresence` class.
 * @template TData Type of data object to share with clients.
 */
export interface ILivePresenceEvents<TData extends object = object>
    extends IEvent {
    /**
     * The presence information for the local or a remote user has changed.
     * @param event Name of event.
     * @param listener Function called when event is triggered.
     * @param listener.user Presence information that changed.
     * @param listener.local If true the local users presence changed.
     */
    (
        event: "presenceChanged",
        listener: (user: LivePresenceUser<TData>, local: boolean) => void
    ): any;
}

/**
 * Live fluid object that synchronizes presence information for the user with other clients.
 * @template TData Type of data object to share with clients.
 */
export class LivePresence<TData extends object = object> extends DataObject<{
    Events: ILivePresenceEvents<TData>;
}> {
    private _logger = new LiveTelemetryLogger(this.runtime);
    private _expirationPeriod = new TimeInterval(20000);
    private _users: LivePresenceUser<TData>[] = [];
    private _currentPresence: ILivePresenceEvent<TData> = {
        name: "UpdatePresence",
        timestamp: 0,
        userId: "",
        state: PresenceState.offline,
        data: undefined,
    };

    private _scope?: LiveEventScope;
    private _updatePresenceEvent?: LiveEventTarget<ILivePresenceEvent<TData>>;
    private _synchronizer?: LiveObjectSynchronizer<ILivePresenceEvent<TData>>;

    /**
     * The objects fluid type/name.
     */
    public static readonly TypeName = `@microsoft/live-share:LivePresence`;

    /**
     * The objects fluid type factory.
     */
    public static readonly factory = new DataObjectFactory(
        LivePresence.TypeName,
        LivePresence,
        [],
        {}
    );

    /**
     * Returns true if the object has been initialized.
     */
    public get isInitialized(): boolean {
        return !!this._scope;
    }

    /**
     * @deprecated isInitialized should be used instead
     * Returns true if the object has been initialized.
     */
    public get isStarted(): boolean {
        return this.isInitialized;
    }

    /**
     * Number of seconds without a presence update before a remote user is considered offline.
     *
     * @remarks
     * Defaults to a value of `20` seconds. The minimum value is 0.1 seconds for testing purposes.
     */
    public get expirationPeriod(): number {
        return this._expirationPeriod.seconds;
    }

    public set expirationPeriod(value: number) {
        this._expirationPeriod.seconds = value > 0.1 ? value : 0.1;
    }

    /**
     * Optional data object shared by the user.
     */
    public get data(): TData | undefined {
        return cloneValue(this._currentPresence.data);
    }

    /**
     * The users current presence state.
     */
    public get state(): PresenceState {
        return this._currentPresence.state;
    }

    /**
     * Returns the ID of the local user.
     */
    public get userId(): string {
        return this._currentPresence.userId;
    }

    /**
     * Starts sharing presence information.
     * @param userId Optional. ID of the local user. Defaults to a GUID if not provided.
     * @param data Optional. Custom data object to sshare. A deep copy of the data object is saved to avoid any accidental modifications.
     * @param state Optional. Initial presence state. Defaults to `PresenceState.online`.
     */
    public async initialize(
        userId?: string,
        data?: TData,
        state = PresenceState.online
    ): Promise<void> {
        if (this._scope) {
            throw new Error(`LivePresence: already started.`);
        }

        // Assign user ID
        // - If we don't set the timestamp the local user object will report as "offline".
        this._currentPresence.timestamp = LiveEvent.getTimestamp();
        this._currentPresence.userId = userId || v4();
        this._currentPresence.data = data;
        this._currentPresence.state = state;

        // Wait for clientId to be assigned.
        this._currentPresence.clientId = await this.waitUntilConnected();

        // Create event scope
        this._scope = new LiveEventScope(this.runtime);

        // Listen for PresenceUpdated event (allow local presence changes to be echoed back)
        this._updatePresenceEvent = new LiveEventTarget(
            this._scope,
            "UpdatePresence",
            (evt, local) => {
                if (!local) {
                    // Update users list
                    this.updateMembersList(evt, local);
                }
            }
        );

        // Create object synchronizer
        this._synchronizer = new LiveObjectSynchronizer<
            ILivePresenceEvent<TData>
        >(
            this.id,
            this.runtime,
            this.context.containerRuntime,
            (connecting) => {
                // Update timestamp for current presence
                // - If we don't do this the user will timeout and show as "offline" for all other
                //   clients. That's because the LiveEvent.isNewer() check will fail.  Updating
                //   the timestamp of the outgoing update is the best way to show proof that the client
                //   is still alive.
                this._currentPresence.timestamp = LiveEvent.getTimestamp();

                // Return current presence
                return this._currentPresence;
            },
            (connecting, state, sender) => {
                // Add user to list
                this.updateMembersList(state!, false);
            }
        );

        // Add local user to list
        this.updateMembersList(this._currentPresence, true);
    }

    /**
     * Disposes of the object when its container is disposed of.
     */
    public dispose(): void {
        super.dispose();
        if (this._synchronizer) {
            this._synchronizer.dispose();
        }
    }

    /**
     * Returns a snapshot of the current list of presence objects being tracked.
     * @returns Array of presence objects.
     */
    public toArray(): LivePresenceUser<TData>[] {
        const list: LivePresenceUser<TData>[] = [];
        this.forEach((presence) => list.push(presence));
        return list;
    }

    /**
     * Updates the users presence state and/or shared data object.
     *
     * @remarks
     * This will trigger the immediate broadcast of the users presence to all other clients.
     * @param state Optional. Presence state to change.
     * @param data Optional. Data object to change. A deep copy of the data object is saved to avoid any future changes.
     */
    public updatePresence(state?: PresenceState, data?: TData): void {
        if (!this._scope) {
            throw new Error(`LivePresence: not started.`);
        }

        // Ensure socket is connected
        this.waitUntilConnected().then((clientId) => {
            // Broadcast state change
            const evt = this._updatePresenceEvent!.sendEvent({
                userId: this._currentPresence.userId,
                state: state ?? this._currentPresence.state,
                data: cloneValue(data) ?? this._currentPresence.data,
            });

            evt.clientId = clientId;

            // Update local presence immediately
            // - The _updatePresenceEvent won't be triggered until the presence change is actually sent. If
            //   the client is disconnected this could be several seconds later.
            this._currentPresence = evt;
            this.updateMembersList(evt, true);
        });
    }

    /**
     * Enumerates each user the object is tracking presence for.
     * @param callback Function to call for each user.
     * @param callback.user Current presence information for a user.
     * @param filter Optional. Presence state to filter enumeration to.
     */
    public forEach(
        callback: (user: LivePresenceUser<TData>) => void,
        filter?: PresenceState
    ): void {
        this._users.forEach((user) => {
            // Ensure user matches filter
            if (filter == undefined || user.state == filter) {
                callback(user);
            }
        });
    }

    /**
     * Counts the number of users that the object is tracking presence for.
     * @param filter Optional. Presence state to filter count to.
     * @returns Total number of other users we've seen or number of users with a given presence status.
     */
    public getCount(filter?: PresenceState): number {
        if (filter != undefined) {
            let cnt = 0;
            this._users.forEach((user) => {
                if (user.state == filter) {
                    cnt++;
                }
            });

            return cnt;
        }

        return this._users.length;
    }

    /**
     * Returns the current presence info for a specific client ID.
     * @param clientId The ID of the client to retrieve.
     * @returns The current presence information for the client if they've connected to the space.
     */
    public getPresenceForClient(
        clientId: string
    ): LivePresenceUser<TData> | undefined {
        for (let i = 0; i < this._users.length; i++) {
            const user = this._users[i];
            if (user.isFromClient(clientId)) {
                return user;
            }
        }

        return undefined;
    }

    /**
     * Returns the current presence info for a specific user.
     * @param userId The ID of the user to retrieve.
     * @returns The current presence information for the user if they've connected to the space.
     */
    public getPresenceForUser(
        userId: string
    ): LivePresenceUser<TData> | undefined {
        for (let i = 0; i < this._users.length; i++) {
            const user = this._users[i];
            if (user.userId == userId) {
                return user;
            }
        }

        return undefined;
    }

    private updateMembersList(
        evt: ILivePresenceEvent<TData>,
        local: boolean
    ): void {
        const emitEvent = (user: LivePresenceUser<TData>) => {
            this.emit(LivePresenceEvents.presenceChanged, user, local);
            if (local) {
                this._logger.sendTelemetryEvent(
                    TelemetryEvents.LivePresence.LocalPresenceChanged,
                    { user: evt }
                );
            } else {
                this._logger.sendTelemetryEvent(
                    TelemetryEvents.LivePresence.RemotePresenceChanged,
                    { user: evt }
                );
            }
        };

        // Find user or where user should be inserted
        let pos = 0;
        const userId = evt.userId;
        for (; pos < this._users.length; pos++) {
            const current = this._users[pos];
            const cmp = userId.localeCompare(current.userId);
            if (cmp == 0) {
                // User found. Apply update and check for changes
                if (current.updateReceived(evt)) {
                    emitEvent(current);
                }

                return;
            } else if (cmp > 0) {
                // New user that should be inserted before this user
                break;
            }
        }

        // Insert new user and send change event
        const newUser = new LivePresenceUser<TData>(
            evt,
            this._expirationPeriod,
            evt.userId == this._currentPresence.userId
        );
        this._users.splice(pos, 0, newUser);
        emitEvent(newUser);
    }

    private waitUntilConnected(): Promise<string> {
        return new Promise((resolve) => {
            const onConnected = (clientId: string) => {
                this.runtime.off("connected", onConnected);
                resolve(clientId);
            };

            if (this.runtime.connected) {
                resolve(this.runtime.clientId as string);
            } else {
                this.runtime.on("connected", onConnected);
            }
        });
    }
}
