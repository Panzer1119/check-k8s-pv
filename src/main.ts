import * as core from "@actions/core";
import * as github from "@actions/github";
import { Commit, PushEvent } from "@octokit/webhooks-types/schema";
import { Octokit } from "@octokit/rest";
import yaml from "js-yaml";

interface Metadata {
    name: string;
    namespace?: string;

    [key: string]: any;
}

interface Resource {
    kind: string;
    metadata: Metadata;

    [key: string]: any;
}

//TODO Maybe extract even which cluster the persistent volume is on

type PersistentVolume = Resource & { kind: "PersistentVolume" };

interface GitTreeItem {
    path?: string;
    mode?: string;
    type?: string;
    sha?: string;
    size?: number;
    url?: string;
}

type GitTree = GitTreeItem[];

const CONFIRMATION_LINE_PERSISTENT_VOLUME_DELETION_START: string = "DELETE_PERSISTENT_VOLUME:";
const CONFIRMATION_LINE_PERSISTENT_VOLUME_DELETION_PAIR_SEPARATOR: string = ",";
const CONFIRMATION_LINE_PERSISTENT_VOLUME_DELETION_METADATA_SEPARATOR: string = "/";

function parseCommitMessage(commitMessage: string): Metadata[] {
    const metadata: Metadata[] = [];
    const lines: string[] = commitMessage.split("\n");
    for (const line of lines) {
        if (!line.startsWith(CONFIRMATION_LINE_PERSISTENT_VOLUME_DELETION_START)) {
            continue;
        }
        const namespaceNamePairs: string[] = line
            .replace(CONFIRMATION_LINE_PERSISTENT_VOLUME_DELETION_START, "")
            .split(CONFIRMATION_LINE_PERSISTENT_VOLUME_DELETION_PAIR_SEPARATOR)
            .map(namespaceNamePair => namespaceNamePair.trim());
        for (const namespaceNamePair of namespaceNamePairs) {
            const namespaceNamePairArray: string[] = namespaceNamePair.split(
                CONFIRMATION_LINE_PERSISTENT_VOLUME_DELETION_METADATA_SEPARATOR
            );
            const metadataObject: Metadata = {
                name: namespaceNamePairArray[1],
                namespace: namespaceNamePairArray[0],
            };
            metadata.push(metadataObject);
        }
    }
    return metadata;
}

const octokit: Octokit = new Octokit({ auth: `token ${process.env.GITHUB_TOKEN}` });

function getFileContent(file_sha: string): Promise<string> {
    return octokit.rest.git
        .getBlob({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            file_sha,
        })
        .then(response => {
            // Check if response is defined
            if (!response) {
                throw new Error("The response is undefined");
            }
            // Check if response is ok
            if (response.status !== 200) {
                throw new Error(`The status code ${response.status} is not supported`);
            }
            // Check if response data is defined
            if (!response.data) {
                throw new Error("The response data is undefined");
            }
            const content: string = response.data.content;
            const encoding: string = response.data.encoding;
            if (encoding !== "base64") {
                throw new Error(`The encoding "${encoding}" is not supported`);
            }
            // Check if content is defined
            if (!content) {
                throw new Error("The content is undefined");
            }
            return Buffer.from(content, "base64").toString();
        });
}

function getTree(tree_sha: string): Promise<GitTree> {
    return octokit.rest.git
        .getTree({
            owner: github.context.repo.owner,
            repo: github.context.repo.repo,
            tree_sha,
        })
        .then(response => {
            // Check if response is defined
            if (!response) {
                throw new Error("The response is undefined");
            }
            // Check if response is ok
            if (response.status !== 200) {
                throw new Error(`The status code ${response.status} is not supported`);
            }
            // Check if response data is defined
            if (!response.data) {
                throw new Error("The response data is undefined");
            }
            const tree: GitTree = response.data.tree as GitTree;
            // Check if tree is defined
            if (!tree) {
                throw new Error("The tree is undefined");
            }
            return tree;
        });
}

async function run(): Promise<void> {
    try {
        // Check if the current run is a push event
        if (github.context.eventName !== "push") {
            throw new Error('This action only supports "push" events');
        }
        const pushEvent: PushEvent = github.context.payload as PushEvent;
        // Check if the push event has a head commit
        if (!pushEvent.head_commit) {
            throw new Error("The push event has no head commit");
        }
        // Print the head commit of the push event
        core.debug(`The head commit is: ${pushEvent.head_commit}`);
        const commits: Commit[] | undefined = pushEvent.commits;
        // Check if the push event has commits
        if (!commits) {
            throw new Error("The push event has no commits");
        }
        // Get the commit messages from the push event
        const commitMessages: string[] = commits.map(commit => commit.message);
        // Parse the commit messages and extract the metadata of the persistent volumes confirmed for deletion
        const deletionConfirmedPersistentVolumeMetadataArray: Metadata[] = commitMessages
            .map(commitMessage => parseCommitMessage(commitMessage))
            .flat();
        // Print the metadata of the persistent volumes confirmed for deletion
        for (const deletionConfirmedPersistentVolumeMetadata of deletionConfirmedPersistentVolumeMetadataArray) {
            core.info(
                `The following persistent volume is confirmed for deletion: ${deletionConfirmedPersistentVolumeMetadata.namespace}/${deletionConfirmedPersistentVolumeMetadata.name}`
            );
        }
        let unconfirmedPersistentVolumeDeletion: boolean = false;
        // Loop over the commits
        for (const commit of commits) {
            // Get the tree of the commit
            const tree: GitTree = await getTree(commit.tree_id);
            // Loop over the deleted files
            for (const deletedFile of commit.removed) {
                // Check if the deleted file is a yaml file
                if (!deletedFile.endsWith(".yaml") && !deletedFile.endsWith(".yml")) {
                    continue;
                }
                // Get the sha of the deleted file
                const deletedFileSha: string | undefined = tree.find(treeItem => treeItem.path === deletedFile)?.sha;
                // Check if the sha of the deleted file is defined
                if (!deletedFileSha) {
                    throw new Error(`The sha of the deleted file "${deletedFile}" is undefined`);
                }
                // Get the content of the deleted file
                const deletedFileContent: string = await getFileContent(deletedFileSha);
                // Safely load all documents from the deleted file
                const deletedFileDocuments: Resource[] = [...yaml.loadAll(deletedFileContent)].map(
                    document => document as Resource
                );
                // Loop over the documents of the deleted file
                for (const deletedFileDocument of deletedFileDocuments) {
                    // Check if the deleted file document is a persistent volume
                    if (deletedFileDocument.kind !== "PersistentVolume") {
                        continue;
                    }
                    // Get the metadata of the deleted persistent volume
                    const metadata: Metadata = deletedFileDocument.metadata;
                    // Check if the metadata of the deleted persistent volume is defined
                    if (!metadata) {
                        throw new Error("The metadata of the deleted persistent volume is undefined");
                    }
                    // Check if the metadata of the deleted persistent volume is included in the metadata of the persistent volumes confirmed for deletion
                    if (deletionConfirmedPersistentVolumeMetadataArray.includes(metadata)) {
                        continue;
                    }
                    // Set the boolean flag "unconfirmedPersistentVolumeDeletion" to true
                    unconfirmedPersistentVolumeDeletion = true;
                    // Print a warning
                    core.warning(
                        `Persistent volume ${metadata.namespace}/${metadata.name} is NOT confirmed for deletion!`
                    );
                }
            }
            // Fail the workflow if there is an unconfirmed persistent volume deletion
            if (unconfirmedPersistentVolumeDeletion) {
                throw new Error("There is one ore more unconfirmed persistent volume deletions");
            }
        }
    } catch (error) {
        if (error instanceof Error) core.setFailed(error.message);
    }
}

run();
