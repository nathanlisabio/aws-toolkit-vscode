/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */
import * as vscode from 'vscode'
import { FolderInfo, transformByQState } from '../../models/model'
import { getLogger } from '../../../shared/logger/logger'
import * as CodeWhispererConstants from '../../models/constants'
// Consider using ChildProcess once we finalize all spawnSync calls
import { spawnSync } from 'child_process' // eslint-disable-line no-restricted-imports
import { CodeTransformBuildCommand, telemetry } from '../../../shared/telemetry/telemetry'
import { CodeTransformTelemetryState } from '../../../amazonqGumby/telemetry/codeTransformTelemetryState'
import { ToolkitError } from '../../../shared/errors'
import { setMaven, writeLogs } from './transformFileHandler'
import { throwIfCancelled } from './transformApiHandler'
import { sleep } from '../../../shared/utilities/timeoutUtils'

// run 'install' with either 'mvnw.cmd', './mvnw', or 'mvn' (if wrapper exists, we use that, otherwise we use regular 'mvn')
function installProjectDependencies(dependenciesFolder: FolderInfo, modulePath: string) {
    telemetry.codeTransform_localBuildProject.run(() => {
        telemetry.record({ codeTransformSessionId: CodeTransformTelemetryState.instance.getSessionId() })

        // baseCommand will be one of: '.\mvnw.cmd', './mvnw', 'mvn'
        const baseCommand = transformByQState.getMavenName()

        transformByQState.appendToErrorLog(`Running command ${baseCommand} clean install`)

        // Note: IntelliJ runs 'clean' separately from 'install'. Evaluate benefits (if any) of this.
        const args = [`-Dmaven.repo.local=${dependenciesFolder.path}`, 'clean', 'install', '-q']

        if (transformByQState.getCustomBuildCommand() === CodeWhispererConstants.skipUnitTestsBuildCommand) {
            args.push('-DskipTests')
        }

        let environment = process.env

        if (transformByQState.getJavaHome() !== undefined) {
            environment = { ...process.env, JAVA_HOME: transformByQState.getJavaHome() }
        }

        const argString = args.join(' ')
        const spawnResult = spawnSync(baseCommand, args, {
            cwd: modulePath,
            shell: true,
            encoding: 'utf-8',
            env: environment,
            maxBuffer: CodeWhispererConstants.maxBufferSize,
        })

        let mavenBuildCommand = transformByQState.getMavenName()
        // slashes not allowed in telemetry
        if (mavenBuildCommand === './mvnw') {
            mavenBuildCommand = 'mvnw'
        } else if (mavenBuildCommand === '.\\mvnw.cmd') {
            mavenBuildCommand = 'mvnw.cmd'
        }

        telemetry.record({ codeTransformBuildCommand: mavenBuildCommand as CodeTransformBuildCommand })

        if (spawnResult.status !== 0) {
            let errorLog = ''
            errorLog += spawnResult.error ? JSON.stringify(spawnResult.error) : ''
            errorLog += `${spawnResult.stderr}\n${spawnResult.stdout}`
            transformByQState.appendToErrorLog(`${baseCommand} ${argString} failed: \n ${errorLog}`)
            getLogger().error(
                `CodeTransformation: Error in running Maven ${argString} command ${baseCommand} = ${errorLog}`
            )
            throw new ToolkitError(`Maven ${argString} error`, { code: 'MavenExecutionError' })
        } else {
            transformByQState.appendToErrorLog(`${baseCommand} ${argString} succeeded`)
        }
    })
}

function copyProjectDependencies(dependenciesFolder: FolderInfo, modulePath: string) {
    // baseCommand will be one of: '.\mvnw.cmd', './mvnw', 'mvn'
    const baseCommand = transformByQState.getMavenName()

    transformByQState.appendToErrorLog(`Running command ${baseCommand} copy-dependencies`)

    const args = [
        'dependency:copy-dependencies',
        `-DoutputDirectory=${dependenciesFolder.path}`,
        '-Dmdep.useRepositoryLayout=true',
        '-Dmdep.copyPom=true',
        '-Dmdep.addParentPoms=true',
        '-q',
    ]

    let environment = process.env
    if (transformByQState.getJavaHome() !== undefined) {
        environment = { ...process.env, JAVA_HOME: transformByQState.getJavaHome() }
    }

    const spawnResult = spawnSync(baseCommand, args, {
        cwd: modulePath,
        shell: true,
        encoding: 'utf-8',
        env: environment,
        maxBuffer: CodeWhispererConstants.maxBufferSize,
    })
    if (spawnResult.status !== 0) {
        let errorLog = ''
        errorLog += spawnResult.error ? JSON.stringify(spawnResult.error) : ''
        errorLog += `${spawnResult.stderr}\n${spawnResult.stdout}`
        transformByQState.appendToErrorLog(`${baseCommand} copy-dependencies failed: \n ${errorLog}`)
        getLogger().info(
            `CodeTransformation: Maven copy-dependencies command ${baseCommand} failed, but still continuing with transformation: ${errorLog}`
        )
        throw new Error('Maven copy-deps error')
    } else {
        transformByQState.appendToErrorLog(`${baseCommand} copy-dependencies succeeded`)
    }
}

export async function prepareProjectDependencies(dependenciesFolder: FolderInfo, rootPomPath: string) {
    await setMaven()
    getLogger().info('CodeTransformation: running Maven copy-dependencies')
    // pause to give chat time to update
    await sleep(100)
    try {
        copyProjectDependencies(dependenciesFolder, rootPomPath)
    } catch (err) {
        // continue in case of errors
        getLogger().info(
            `CodeTransformation: Maven copy-dependencies failed, but transformation will continue and may succeed`
        )
    }

    getLogger().info('CodeTransformation: running Maven install')
    try {
        installProjectDependencies(dependenciesFolder, rootPomPath)
    } catch (err) {
        void vscode.window.showErrorMessage(CodeWhispererConstants.cleanInstallErrorNotification)
        // open build-logs.txt file to show user error logs
        const logFilePath = await writeLogs()
        const doc = await vscode.workspace.openTextDocument(logFilePath)
        await vscode.window.showTextDocument(doc)
        throw err
    }

    throwIfCancelled()
    void vscode.window.showInformationMessage(CodeWhispererConstants.buildSucceededNotification)
}

export async function getVersionData() {
    const baseCommand = transformByQState.getMavenName() // will be one of: 'mvnw.cmd', './mvnw', 'mvn'
    const projectPath = transformByQState.getProjectPath()
    const args = ['-v']
    const spawnResult = spawnSync(baseCommand, args, { cwd: projectPath, shell: true, encoding: 'utf-8' })

    let localMavenVersion: string | undefined = ''
    let localJavaVersion: string | undefined = ''

    try {
        const localMavenVersionIndex = spawnResult.stdout.indexOf('Apache Maven')
        const localMavenVersionString = spawnResult.stdout.slice(localMavenVersionIndex + 13).trim()
        localMavenVersion = localMavenVersionString.slice(0, localMavenVersionString.indexOf(' ')).trim()
    } catch (e: any) {
        localMavenVersion = undefined // if this happens here or below, user most likely has JAVA_HOME incorrectly defined
    }

    try {
        const localJavaVersionIndex = spawnResult.stdout.indexOf('Java version: ')
        const localJavaVersionString = spawnResult.stdout.slice(localJavaVersionIndex + 14).trim()
        localJavaVersion = localJavaVersionString.slice(0, localJavaVersionString.indexOf(',')).trim() // will match value of JAVA_HOME
    } catch (e: any) {
        localJavaVersion = undefined
    }

    getLogger().info(
        `CodeTransformation: Ran ${baseCommand} to get Maven version = ${localMavenVersion} and Java version = ${localJavaVersion} with project JDK = ${transformByQState.getSourceJDKVersion()}`
    )
    return [localMavenVersion, localJavaVersion]
}

// run maven 'versions:dependency-updates-aggregate-report' with either 'mvnw.cmd', './mvnw', or 'mvn' (if wrapper exists, we use that, otherwise we use regular 'mvn')
export function runMavenDependencyUpdateCommands(dependenciesFolder: FolderInfo) {
    // baseCommand will be one of: '.\mvnw.cmd', './mvnw', 'mvn'
    const baseCommand = transformByQState.getMavenName() // will be one of: 'mvnw.cmd', './mvnw', 'mvn'

    // Note: IntelliJ runs 'clean' separately from 'install'. Evaluate benefits (if any) of this.
    const args = [
        'versions:dependency-updates-aggregate-report',
        `-DoutputDirectory=${dependenciesFolder.path}`,
        '-DonlyProjectDependencies=true',
        '-DdependencyUpdatesReportFormats=xml',
    ]

    let environment = process.env
    // if JAVA_HOME not found or not matching project JDK, get user input for it and set here
    if (transformByQState.getJavaHome() !== undefined) {
        environment = { ...process.env, JAVA_HOME: transformByQState.getJavaHome() }
    }

    const spawnResult = spawnSync(baseCommand, args, {
        // default behavior is looks for pom.xml in this root
        cwd: dependenciesFolder.path,
        shell: true,
        encoding: 'utf-8',
        env: environment,
        maxBuffer: CodeWhispererConstants.maxBufferSize,
    })

    if (spawnResult.status !== 0) {
        throw new Error(spawnResult.stderr)
    } else {
        return spawnResult.stdout
    }
}
