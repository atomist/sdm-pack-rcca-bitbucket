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

import {
    automationClientInstance,
    configurationValue,
    DefaultHttpClientFactory,
    HandlerResult,
    HttpClientFactory,
    HttpMethod,
    logger,
    ProjectOperationCredentials,
    Secrets,
    Success,
} from "@atomist/automation-client";
import { BasicAuthCredentials } from "@atomist/automation-client/lib/operations/common/BasicAuthCredentials";
import {
    DeclarationType,
    ExtensionPack,
    metadata,
    ParametersObject,
} from "@atomist/sdm";
import {
    AutoMergeOnReview,
    BuildStatus,
} from "../typings/types";
import { autoMergeOnBuild } from "./AutoMergeOnBuild";
import { autoMergeOnPullRequest } from "./AutoMergeOnPullRequest";
import { autoMergeOnReview } from "./AutoMergeOnReview";

export const AtomistGeneratedLabel = "atomist:generated";

export const AutoMergeTag = `[auto-merge:on-approve]`;
export const AutoMergeCheckSuccessTag = `[auto-merge:on-check-success]`;

export const AutoMergeMethodLabel = "auto-merge-method:";
export const AutoMergeMethods = ["merge-commit", "fast-forward", "squash"];

export const OrgTokenParameters: ParametersObject<{ token: string }>
    = { token: { declarationType: DeclarationType.Secret, uri: Secrets.OrgToken } };

export function bitbucketAutoMergeSupport(): ExtensionPack {
    return {
        ...metadata("bitbucket-auto-merge"),
        configure: sdm => {
            sdm.addEvent(autoMergeOnBuild(sdm))
                .addEvent(autoMergeOnPullRequest(sdm))
                .addEvent(autoMergeOnReview(sdm));
        },
    };
}

async function canBeMerged(creds: ProjectOperationCredentials, apiBaseUrl: string, pr: AutoMergeOnReview.PullRequest): Promise<boolean> {
    return true;
}

function getBasicHeader(creds: ProjectOperationCredentials): string {
    const basicAuth = creds as BasicAuthCredentials;
    const base64 = Buffer.from(`${basicAuth.username}:${basicAuth.password}`).toString("base64");
    return `Basic ${base64}`;
}

async function getCurrentPRVersion(apiBaseUrl: string, creds: ProjectOperationCredentials, owner: string, name: string, pr: number): Promise<number> {
    const apiCall = `${apiBaseUrl}/projects/${owner}/repos/${name}/pull-requests/${pr}`;
    const httpClient = configurationValue<HttpClientFactory>("http.client.factory").create();
    const response = await httpClient.exchange(apiCall, {
        method: HttpMethod.Get,
        headers: {
            Authorization: getBasicHeader(creds),
        },
    });
    const prBody = response.body as any;
    return prBody.version as number;
}

async function mergePullRequest(creds: ProjectOperationCredentials, apiBaseUrl: string, pr: AutoMergeOnReview.PullRequest): Promise<void> {
    const currentVersion = await getCurrentPRVersion(apiBaseUrl, creds, pr.repo.owner, pr.repo.name, pr.number);
    const apiCall = `${apiBaseUrl}/projects/${pr.repo.owner}/repos/${pr.repo.name}/pull-requests/${pr.number}/merge?version=${currentVersion}`;
    const httpClient = configurationValue<HttpClientFactory>("http.client.factory").create();
    await httpClient.exchange(apiCall, {
        method: HttpMethod.Post,
        headers: {
            Authorization: getBasicHeader(creds),
        },
    });
}

async function createMergedPullRequestComment(creds: ProjectOperationCredentials, apiBaseUrl: string, pr: AutoMergeOnReview.PullRequest): Promise<void> {
    const apiCall = `${apiBaseUrl}/projects/${pr.repo.owner}/repos/${pr.repo.name}/pull-requests/${pr.number}/comments`;
    const httpClient = configurationValue<HttpClientFactory>("http.client.factory").create();
    const body = {
        text: `Pull request auto merged by Atomist.

* ${reviewComment(pr)}
* ${statusComment(pr)}

[${AtomistGeneratedLabel}] ${isPrTagged(
            pr, AutoMergeCheckSuccessTag) ? AutoMergeCheckSuccessTag : AutoMergeTag}`,
    };
    await httpClient.exchange(apiCall, {
        method: HttpMethod.Post,
        headers: {
            Authorization: getBasicHeader(creds),
        },
        body,
    });
}

// tslint:disable-next-line:cyclomatic-complexity
export async function executeAutoMerge(pr: AutoMergeOnReview.PullRequest,
                                       creds: ProjectOperationCredentials): Promise<HandlerResult> {
    if (!!pr) {
        // 1. at least one approved review if PR isn't set to merge on successful build
        if (isPrTagged(pr, AutoMergeTag)) {
            if (!pr.reviews || pr.reviews.length === 0) {
                return Success;
            } else if (pr.reviews.some(r => r.state !== "approved")) {
                return Success;
            }
        }

        // 2. all build checks are successful and there is at least one check
        if (pr.head && pr.head.builds && pr.head.builds.length > 0) {
            if (pr.head.builds.some(b => b.status !== BuildStatus.passed)) {
                return Success;
            }
        } else {
            return Success;
        }

        if (isPrAutoMergeEnabled(pr)) {
            if (await canBeMerged(creds, apiUrl(pr.repo), pr)) {
                await mergePullRequest(creds, apiUrl(pr.repo), pr);
                await createMergedPullRequestComment(creds, apiUrl(pr.repo), pr);
                return Success;
            } else {
                logger.info("PR is not mergeable: '%j'", pr.number);
                return Success;
            }
        }
    }
    return Success;
}

export function isPrAutoMergeEnabled(pr: AutoMergeOnReview.PullRequest): boolean {
    return isPrTagged(pr, AutoMergeTag)
        || isPrTagged(pr, AutoMergeCheckSuccessTag);
}

function isPrTagged(pr: AutoMergeOnReview.PullRequest,
                    tag: string): boolean {
    // 1. check body and title for auto merge marker
    if (isTagged(pr.title, tag) || isTagged(pr.body, tag)) {
        return true;
    }

    // 2. PR comment that contains the merger
    if (pr.reviews && pr.reviews.some(r => r.comments && r.comments.some(c => isTagged(c.body, tag)))) {
        return true;
    }

    // 3. Commit message containing the auto merge marker
    if (pr.commits && pr.commits.some(c => isTagged(c.message, tag))) {
        return true;
    }

    return false;
}

function mergeMethod(pr: AutoMergeOnReview.PullRequest): "merge_commit" | "fast_forward" | "squash" {
    const methodLabel = pr.labels.find(l => l.name.startsWith(AutoMergeMethodLabel));
    if (methodLabel && methodLabel.name.includes(":")) {
        const method = methodLabel.name.split(":")[1].toLowerCase() as any;
        if (AutoMergeMethods.includes(method)) {
            return method;
        }
    }
    return "merge_commit";
}

function isTagged(msg: string, tag: string): boolean {
    return msg && msg.indexOf(tag) >= 0;
}

function reviewComment(pr: AutoMergeOnReview.PullRequest): string {
    if (pr.reviews && pr.reviews.length > 0) {
        return `${pr.reviews.length} approved ${pr.reviews.length > 1 ? "reviews" : "review"} by ${pr.reviews.map(
            r => `${r.by.map(b => `@${b.login}`).join(", ")}`).join(", ")}`;
    } else {
        return "No reviews";
    }
}

function statusComment(pr: AutoMergeOnReview.PullRequest): string {
    if (pr.head && pr.head.builds && pr.head.builds.length > 0) {
        return `${pr.head.builds.length} successful ${pr.head.builds.length > 1 ? "checks" : "check"}`;
    } else {
        return "No checks";
    }
}

function apiUrl(repo: any): string {
    if (repo.org && repo.org.provider && repo.org.provider.apiUrl) {
        let providerUrl = repo.org.provider.apiUrl;
        if (providerUrl.slice(-1) === "/") {
            providerUrl = providerUrl.slice(0, -1);
        }
        return providerUrl;
    } else {
        return undefined;
    }
}
