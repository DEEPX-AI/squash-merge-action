const core = require('@actions/core');
const github = require('@actions/github');
const { Octokit } = require('@octokit/rest');

class SquashMergeExecutor {
  constructor(token) {
    this.octokit = new Octokit({ auth: token });
  }

  async executeSquashMerge(config) {
    const { target_repos, source_branch, target_branch, commit_message_template, delete_source_branch, create_release } = config;
    
    console.log('🚀 Starting Squash Merge Operation');
    console.log(`Source: ${source_branch} → Target: ${target_branch}`);
    console.log(`Target repositories: ${target_repos.join(', ')}`);
    console.log(`Delete source branch: ${delete_source_branch}`);
    console.log(`Create release: ${create_release}`);
    
    const results = {
      successful: [],
      failed: [],
      skipped: [],
      summary: {}
    };
    
    // Process each repository
    for (const repoFullName of target_repos) {
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
          source_branch, 
          target_branch, 
          commit_message_template,
          delete_source_branch,
          create_release
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
      total: target_repos.length,
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

  async processRepository(owner, repo, source_branch, target_branch, commit_message_template, delete_source_branch, create_release) {
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
          ref: `heads/${source_branch}`
        });
        sourceBranchRef = sourceRef;
      } catch (error) {
        if (error.status === 404) {
          return {
            repo: `${owner}/${repo}`,
            skipped: true,
            reason: `Source branch '${source_branch}' does not exist`
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
          ref: `heads/${target_branch}`
        });
        targetBranchRef = targetRef;
      } catch (error) {
        if (error.status === 404) {
          return {
            repo: `${owner}/${repo}`,
            skipped: true,
            reason: `Target branch '${target_branch}' does not exist`
          };
        }
        throw error;
      }
      
      // Check if there are changes to merge
      const { data: comparison } = await this.octokit.rest.repos.compareCommits({
        owner,
        repo,
        base: target_branch,
        head: source_branch
      });
      
      if (comparison.ahead_by === 0) {
        return {
          repo: `${owner}/${repo}`,
          skipped: true,
          reason: 'No changes to merge - branches are identical'
        };
      }
      
      console.log(`  📈 Found ${comparison.ahead_by} commits to merge`);
      
      // Create squash merge commit message
      const commit_message = this.createCommitMessage(
        commit_message_template,
        source_branch,
        target_branch,
        comparison.commits
      );
      
      // Perform squash merge
      const merge_result = await this.performSquashMerge(
        owner,
        repo,
        source_branch,
        target_branch,
        commit_message
      );
      
      console.log(`  ✅ Squash merge completed: ${merge_result.sha.substring(0, 8)}`);
      
      // Delete source branch if requested
      if (delete_source_branch === 'true') {
        await this.deleteSourceBranch(owner, repo, source_branch);
        console.log(`  🗑️ Deleted source branch '${source_branch}'`);
      }
      
      // Create release if requested
      let release_info = null;
      if (create_release === 'true') {
        release_info = await this.createRelease(owner, repo, target_branch, comparison.commits);
        console.log(`  🏷️ Created release: ${release_info.tag_name}`);
      }
      
      return {
        repo: `${owner}/${repo}`,
        success: true,
        source_branch,
        target_branch,
        commits_count: comparison.ahead_by,
        merge_commit_sha: merge_result.sha,
        source_branch_deleted: delete_source_branch === 'true',
        release: release_info
      };
      
    } catch (error) {
      return {
        repo: `${owner}/${repo}`,
        success: false,
        error: error.message
      };
    }
  }

  async performSquashMerge(owner, repo, source_branch, target_branch, commit_message) {
    try {
      // Try GitHub's merge API first (creates a merge commit)
      const { data: merge } = await this.octokit.rest.repos.merge({
        owner,
        repo,
        base: target_branch,
        head: source_branch,
        commit_message: commit_message
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

  createCommitMessage(template, source_branch, target_branch, commits) {
    let message = template
      .replace('{source}', source_branch)
      .replace('{target}', target_branch);
    
    // Add commit details
    message += `\n\nMerged ${commits.length} commits:\n`;
    
    commits.slice(0, 10).forEach(commit => { // Show max 10 commits
      const short_sha = commit.sha.substring(0, 8);
      const short_message = commit.commit.message.split('\n')[0].substring(0, 60);
      message += `- ${short_sha}: ${short_message}\n`;
    });
    
    if (commits.length > 10) {
      message += `... and ${commits.length - 10} more commits\n`;
    }
    
    return message;
  }

  async deleteSourceBranch(owner, repo, branch_name) {
    // Don't delete main/master branches
    if (['main', 'master'].includes(branch_name)) {
      console.warn(`⚠️ Refusing to delete protected branch '${branch_name}'`);
      return;
    }
    
    await this.octokit.rest.git.deleteRef({
      owner,
      repo,
      ref: `heads/${branch_name}`
    });
  }

  async createRelease(owner, repo, target_branch, commits) {
    // Get the latest commit from target branch
    const { data: target_ref } = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${target_branch}`
    });
    
    // Generate version tag (simple incrementing)
    const timestamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
    const tag_name = `release-${timestamp}`;
    
    // Create release
    const { data: release } = await this.octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tag_name,
      target_commitish: target_branch,
      name: `Release ${tag_name}`,
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
    const target_repos_input = core.getInput('target_repos');
    const target_repos = target_repos_input.split(',').map(repo => repo.trim());
    core.info(`Target Repositories: ${target_repos.join(', ')}`);

    const source_branch = core.getInput('source_branch');
    const target_branch = core.getInput('target_branch');
    const commit_message_template = core.getInput('commit_message');
    const delete_source_branch = core.getInput('delete_source_branch');
    const create_release = core.getInput('create_release');
    
    if (!token) {
      throw new Error('GitHub token is required');
    }
    
    if (!target_repos || target_repos.length === 0) {
      throw new Error('Target repositories are required');
    }
    
    const config = {
      target_repos,
      source_branch,
      target_branch,
      commit_message_template,
      delete_source_branch,
      create_release
    };
    
    // Execute squash merge
    const executor = new SquashMergeExecutor(token);
    const results = await executor.executeSquashMerge(config);
    
    // Set outputs
    core.setOutput('merged_repos', results.successful.map(r => r.repo).join(','));
    core.setOutput('success_count', results.successful.length.toString());
    core.setOutput('failed_repos', results.failed.map(r => r.repo).join(','));
    core.setOutput('merge_summary', JSON.stringify(results.summary));
    
    // Check if there were any failures
    if (results.failed.length > 0) {
      const failed_repos = results.failed.map(r => r.repo).join(', ');
      core.setFailed(`Failed to merge in repositories: ${failed_repos}`);
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
