/*
 * Copyright © 2019 Atomist, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as GraphQL from "@atomist/automation-client/lib/graph/graphQL";
import {
    EventHandlerRegistration,
    resolveCredentialsPromise,
    SoftwareDeliveryMachine,
} from "@atomist/sdm";
import * as _ from "lodash";
import { AutoMergeOnReview } from "../typings/types";
import {
    executeAutoMerge,
    OrgTokenParameters,
} from "./autoMerge";

export function autoMergeOnReview(sdm: SoftwareDeliveryMachine)
    : EventHandlerRegistration<AutoMergeOnReview.Subscription, { token: string }> {
    return {
        name: "AutoMergeOnReview",
        description: "Auto merge reviewed and approved pull requests on Review events",
        subscription: GraphQL.subscription("autoMergeOnReview"),
        parameters: OrgTokenParameters,
        tags: ["github", "pr", "automerge"],
        listener: async (e, ctx) => {
            const creds = await resolveCredentialsPromise(sdm.configuration.sdm.credentialsResolver.eventHandlerCredentials(ctx));
            const pr = _.get(e, "data.Review[0].pullRequest");
            return executeAutoMerge(pr, creds);
        },
    };
}
