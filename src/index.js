const core = require('@actions/core');
const github = require('@actions/github');
const { Octokit } = require('@octokit/rest');

class SquashMergeExecutor {
  constructor(token) {
    this.octokit = new Octokit({ auth: token });
  }

  async executeSquashMerge(config) {
    const { targetRepos, sourceBranch, targetBranch, commitMessageTemplate, deleteSourceBranch, createRelease } = config;
    
    console.log('🚀 Starting Squash Merge Operation');
    console.log(`Source: ${sourceBranch} → Target: ${targetBranch}`);
    console.log(`Target repositories: ${targetRepos.join(', ')}`);
    console.log(`Delete source branch: ${deleteSourceBranch}`);
    console.log(`Create release: ${createRelease}`);
    
    const results = {
      successful: [],
      failed: [],
      skipped: [],
      summary: {}
    };
    
    // Process each repository
    for (const repoFullName of targetRepos) {
      try {
        const [owner, repo] = repoFullName.split('/');
        
        if (!owner || !repo) {
          console.error(`❌ Invalid repository format: ${repoFullName}`);
          results.failed.push({
            repo: repoFullName,
            error: 'Invalid repository format'
          });
          continue;
        }
        
        console.log(`\n📦 Processing ${repoFullName}...`);
        
        const result = await this.processRepository(
          owner, 
          repo, 
          sourceBranch, 
          targetBranch, 
          commitMessageTemplate,
          deleteSourceBranch,
          createRelease
        );
        
        if (result.success) {
          results.successful.push(result);
          console.log(`✅ Successfully processed ${repoFullName}`);
        } else if (result.skipped) {
          results.skipped.push(result);
          console.log(`⏭️ Skipped ${repoFullName}: ${result.reason}`);
        } else {
          results.failed.push(result);
          console.error(`❌ Failed to process ${repoFullName}: ${result.error}`);
        }
        
      } catch (error) {
        console.error(`❌ Unexpected error processing ${repoFullName}:`, error.message);
        results.failed.push({
          repo: repoFullName,
          error: error.message
        });
      }
    }
    
    // Generate summary
    results.summary = {
      total: targetRepos.length,
      successful: results.successful.length,
      failed: results.failed.length,
      skipped: results.skipped.length
    };
    
    console.log('\n📊 Final Summary:');
    console.log(`Total repositories: ${results.summary.total}`);
    console.log(`Successful: ${results.summary.successful}`);
    console.log(`Failed: ${results.summary.failed}`);
    console.log(`Skipped: ${results.summary.skipped}`);
    
    return results;
  }

  async processRepository(owner, repo, sourceBranch, targetBranch, commitMessageTemplate, deleteSourceBranch, createRelease) {
    try {
      // Check if repository exists and is accessible
      try {
        await this.octokit.rest.repos.get({ owner, repo });
      } catch (error) {
        console.error(`❌ Failed to access ${owner}/${repo}:`, error);
        throw new Error(`Repository ${owner}/${repo} not accessible: ${error.message}`);
      }
      
      // Check if source branch exists
      let sourceBranchRef;
      try {
        const { data: sourceRef } = await this.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${sourceBranch}`
        });
        sourceBranchRef = sourceRef;
      } catch (error) {
        if (error.status === 404) {
          return {
            repo: `${owner}/${repo}`,
            skipped: true,
            reason: `Source branch '${sourceBranch}' does not exist`
          };
        }
        throw error;
      }
      
      // Check if target branch exists
      let targetBranchRef;
      try {
        const { data: targetRef } = await this.octokit.rest.git.getRef({
          owner,
          repo,
          ref: `heads/${targetBranch}`
        });
        targetBranchRef = targetRef;
      } catch (error) {
        if (error.status === 404) {
          return {
            repo: `${owner}/${repo}`,
            skipped: true,
            reason: `Target branch '${targetBranch}' does not exist`
          };
        }
        throw error;
      }
      
      // Check if there are changes to merge
      const { data: comparison } = await this.octokit.rest.repos.compareCommits({
        owner,
        repo,
        base: targetBranch,
        head: sourceBranch
      });
      
      if (comparison.ahead_by === 0) {
        return {
          repo: `${owner}/${repo}`,
          skipped: true,
          reason: 'No changes to merge - branches are identical'
        };
      }
      
      console.log(`  📈 Found ${comparison.ahead_by} commits to merge`);
      
      // Create squash merge commit message
      const commitMessage = this.createCommitMessage(
        commitMessageTemplate,
        sourceBranch,
        targetBranch,
        comparison.commits
      );
      
      // Perform squash merge
      const mergeResult = await this.performSquashMerge(
        owner,
        repo,
        sourceBranch,
        targetBranch,
        commitMessage
      );
      
      console.log(`  ✅ Squash merge completed: ${mergeResult.sha.substring(0, 8)}`);
      
      // Delete source branch if requested
      if (deleteSourceBranch === 'true') {
        await this.deleteSourceBranch(owner, repo, sourceBranch);
        console.log(`  🗑️ Deleted source branch '${sourceBranch}'`);
      }
      
      // Create release if requested
      let releaseInfo = null;
      if (createRelease === 'true') {
        releaseInfo = await this.createRelease(owner, repo, targetBranch, comparison.commits);
        console.log(`  🏷️ Created release: ${releaseInfo.tag_name}`);
      }
      
      return {
        repo: `${owner}/${repo}`,
        success: true,
        sourceBranch,
        targetBranch,
        commitsCount: comparison.ahead_by,
        mergeCommitSha: mergeResult.sha,
        sourceBranchDeleted: deleteSourceBranch === 'true',
        release: releaseInfo
      };
      
    } catch (error) {
      return {
        repo: `${owner}/${repo}`,
        success: false,
        error: error.message
      };
    }
  }

  async performSquashMerge(owner, repo, sourceBranch, targetBranch, commitMessage) {
    try {
      // Try GitHub's merge API first (creates a merge commit)
      const { data: merge } = await this.octokit.rest.repos.merge({
        owner,
        repo,
        base: targetBranch,
        head: sourceBranch,
        commit_message: commitMessage
      });
      
      return merge;
    } catch (error) {
      if (error.status === 409) {
        // Merge conflict - need manual resolution
        throw new Error('Merge conflict detected - manual resolution required');
      } else if (error.status === 204) {
        // Nothing to merge
        throw new Error('Nothing to merge - branches are identical');
      }
      throw error;
    }
  }

  createCommitMessage(template, sourceBranch, targetBranch, commits) {
    let message = template
      .replace('{source}', sourceBranch)
      .replace('{target}', targetBranch);
    
    // Add commit details
    message += `\n\nMerged ${commits.length} commits:\n`;
    
    commits.slice(0, 10).forEach(commit => { // Show max 10 commits
      const shortSha = commit.sha.substring(0, 8);
      const shortMessage = commit.commit.message.split('\n')[0].substring(0, 60);
      message += `- ${shortSha}: ${shortMessage}\n`;
    });
    
    if (commits.length > 10) {
      message += `... and ${commits.length - 10} more commits\n`;
    }
    
    return message;
  }

  async deleteSourceBranch(owner, repo, branchName) {
    // Don't delete main/master branches
    if (['main', 'master'].includes(branchName)) {
      console.warn(`⚠️ Refusing to delete protected branch '${branchName}'`);
      return;
    }
    
    await this.octokit.rest.git.deleteRef({
      owner,
      repo,
      ref: `heads/${branchName}`
    });
  }

  async createRelease(owner, repo, targetBranch, commits) {
    // Get the latest commit from target branch
    const { data: targetRef } = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${targetBranch}`
    });
    
    // Generate version tag (simple incrementing)
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const tagName = `release-${timestamp}`;
    
    // Create release
    const { data: release } = await this.octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tagName,
      target_commitish: targetBranch,
      name: `Release ${tagName}`,
      body: this.generateReleaseNotes(commits),
      draft: false,
      prerelease: false
    });
    
    return release;
  }

  generateReleaseNotes(commits) {
    let notes = '## Changes\n\n';
    
    commits.forEach(commit => {
      const message = commit.commit.message.split('\n')[0];
      notes += `- ${message} (${commit.sha.substring(0, 8)})\n`;
    });
    
    return notes;
  }
}

async function main() {
  try {
    // Get inputs
    const token = core.getInput('token');
    const targetReposInput = core.getInput('target-repos');
    const targetRepos = targetReposInput.split(',').map(repo => repo.trim());
    core.info(`Target Repositories: ${targetRepos.join(', ')}`);

    const sourceBranch = core.getInput('source-branch');
    const targetBranch = core.getInput('target-branch');
    const commitMessageTemplate = core.getInput('commit-message');
    const deleteSourceBranch = core.getInput('delete-source-branch');
    const createRelease = core.getInput('create-release');
    
    if (!token) {
      throw new Error('GitHub token is required');
    }
    
    if (!targetRepos || targetRepos.length === 0) {
      throw new Error('Target repositories are required');
    }
    
    const config = {
      targetRepos,
      sourceBranch,
      targetBranch,
      commitMessageTemplate,
      deleteSourceBranch,
      createRelease
    };
    
    // Execute squash merge
    const executor = new SquashMergeExecutor(token);
    const results = await executor.executeSquashMerge(config);
    
    // Set outputs
    core.setOutput('merged-repos', results.successful.map(r => r.repo).join(','));
    core.setOutput('success-count', results.successful.length.toString());
    core.setOutput('failed-repos', results.failed.map(r => r.repo).join(','));
    core.setOutput('merge-summary', JSON.stringify(results.summary));
    
    // Check if there were any failures
    if (results.failed.length > 0) {
      const failedRepos = results.failed.map(r => r.repo).join(', ');
      core.setFailed(`Failed to merge in repositories: ${failedRepos}`);
      return;
    }
    
    // Check if all were skipped
    if (results.successful.length === 0 && results.skipped.length > 0) {
      console.log('ℹ️ All repositories were skipped - no merges needed');
    }
    
    console.log('🎉 Squash merge operation completed successfully!');
    
  } catch (error) {
    console.error('Squash merge operation failed:', error.message);
    core.setFailed(error.message);
  }
}

// Run the action
if (require.main === module) {
  main();
}

module.exports = main;
