const core = require('@actions/core');
const github = require('@actions/github');
const { Octokit } = require('@octokit/rest');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

class SquashMergeExecutor {
  constructor(token) {
    this.octokit = new Octokit({ auth: token });
    this.token = token; // 토큰을 별도로 저장
  }

  async executeSquashMerge(config) {
    const { target_repos, source_branch, target_branch, delete_source_branch, create_release } = config;
    
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

  async processRepository(owner, repo, source_branch, target_branch, delete_source_branch, create_release) {
    try {      
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
      
      console.log(`  📈 Found ${comparison.ahead_by} commits to merge`);
      
      // Perform squash merge using git commands
      const merge_result = await this.performSquashMerge(
        owner,
        repo,
        source_branch,
        target_branch
      );
      
      console.log(`  ✅ Squash merge completed`);
      
      // Delete source branch if requested
      if (delete_source_branch === 'true') {
        await this.deleteSourceBranch(owner, repo, source_branch);
        console.log(`  🗑️ Deleted source branch '${source_branch}'`);
        console.log(` Recreating '${source_branch}' branch from updated '${target_branch}' branch`);
        await this.recreateSourceBranchAfterDeletion(owner, repo, source_branch, target_branch);
      }
      
      // Create release if requested
      let release_info = null;
      if (create_release === 'true') {
        release_info = await this.createRelease(owner, repo, target_branch, comparison.commits);
        console.log(`  🏷️ Created release: ${release_info.tag_name}`);
      }
      
      return {
        repo: `${owner}/${repo}`,
        success: true,
        source_branch,
        target_branch,
        commits_count: comparison.ahead_by,
        merge_commit_sha: merge_result.sha,
        commit_message: merge_result.commit_message,
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

  async performSquashMerge(owner, repo, source_branch, target_branch) {
    let originalDir = process.cwd();
    
    try {
      // git 명령어를 사용하기 위해 작업 디렉토리로 이동
      const { stdout: repoDir } = await execPromise(`mktemp -d`);
      const repoPath = repoDir.trim();

      // 레포지토리 클론 - this.token 사용
      console.log(`  ⬇️ Cloning repository ${owner}/${repo}...`);
      await execPromise(`git clone https://x-access-token:${this.token}@github.com/${owner}/${repo}.git ${repoPath}`);

      // 작업 디렉토리로 이동
      process.chdir(repoPath);
      
      // Git config 설정 (GitHub Actions에서 필요)
      await execPromise(`git config user.name "dx-ci"`);
      await execPromise(`git config user.email "dci@deepx.ai"`);
      
      // 메인 브랜치로 체크아웃
      await execPromise(`git checkout ${target_branch}`);
      
      // staging 브랜치의 최신 변경사항을 가져옴
      await execPromise(`git fetch origin ${source_branch}`);

      // staging 브랜치의 release.ver 파일을 읽어 커밋 메시지로 사용
      console.log(`  📄 Reading release.ver from ${source_branch} branch...`);
      await execPromise(`git checkout origin/${source_branch} -- release.ver`);
      
      const fs = require('fs').promises;
      let commit_message;
      try {
        const releaseVerContent = await fs.readFile('release.ver', 'utf8');
        commit_message = releaseVerContent.trim();
        if (!commit_message) {
          throw new Error('release.ver file is empty.');
        }
        console.log(`  📝 Using commit message from release.ver: "${commit_message}"`);
      } catch (error) {
        console.warn(`⚠️ Could not read release.ver from ${source_branch} branch. Using default commit message.`);
        commit_message = 'chore: squash merge'; // 파일이 없거나 읽을 수 없을 때 사용할 기본 메시지
      } finally {
        // 임시로 가져온 release.ver 파일을 정리
        await execPromise('rm release.ver');
      }

      // squash merge 수행
      console.log(`  🔄 Squash merging ${source_branch} into ${target_branch}...`);
      await execPromise(`git merge --squash origin/${source_branch}`);

      // 커밋 메시지 추가 - 특수문자 escape 처리
      const escaped_message = commit_message.replace(/"/g, '\\"');
      await execPromise(`git commit -m "${escaped_message}"`);

      // 푸시
      console.log(`  ⬆️ Pushing changes to ${target_branch}...`);
      await execPromise(`git push origin ${target_branch}`);
      
      const { stdout: latest_commit_sha } = await execPromise(`git rev-parse HEAD`);
      
      return { 
        sha: latest_commit_sha.trim(),
        commit_message
      };
    } catch (error) {
      if (error.stderr && error.stderr.includes('fatal: refusing to merge unrelated histories')) {
        throw new Error('Merge conflict detected - manual resolution required');
      }
      if (error.stderr && error.stderr.includes('nothing to commit')) {
        throw new Error('Nothing to merge - branches are identical');
      }
      throw error;
    } finally {
      // 원래 디렉토리로 복원
      process.chdir(originalDir);
    }
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

  async recreateSourceBranchAfterDeletion(owner, repo, branch_name, base_branch) {
    const { data: baseRefData } = await this.octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${base_branch}`,
    });

    const baseSha = baseRefData.object.sha;

    console.log(`🔁 Creating branch '${branch_name}' from '${base_branch}' at commit ${baseSha}`);

    // Create a new branch pointing to the base branch's latest commit
    await this.octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branch_name}`,
      sha: baseSha,
    });

    console.log(`✅ Branch '${branch_name}' successfully recreated from '${base_branch}'`);
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

function determineBumpTypeFromMessage(message) {
  const lowerMessage = message.toLowerCase().trim();
  if (lowerMessage.includes('major') || lowerMessage.startsWith('major:')) return 'major';
  if (lowerMessage.includes('minor') || lowerMessage.startsWith('minor:')) return 'minor';
  if (lowerMessage.includes('patch') || lowerMessage.startsWith('patch:')) return 'patch';
  return null;
}

function getHigherBumpType(typeA, typeB) {
  const levels = { patch: 1, minor: 2, major: 3 };
  if (!typeA) return typeB;
  if (!typeB) return typeA;
  return levels[typeA] > levels[typeB] ? typeA : typeB;
}

async function main() {
  try {
    // Get inputs - 언더스코어 사용
    const token = core.getInput('token');
    const target_repos_input = core.getInput('target_repos');
    const target_repos = target_repos_input.split(',').map(repo => repo.trim());
    core.info(`Target Repositories: ${target_repos.join(', ')}`);

    const source_branch = core.getInput('source_branch');
    const target_branch = core.getInput('target_branch');
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
      delete_source_branch,
      create_release
    };
    
    // Execute squash merge
    const executor = new SquashMergeExecutor(token);
    const results = await executor.executeSquashMerge(config);

    // Extract highest bump type from all merged commit messages
    let highestBumpType = null;
    for (const result of results.successful) {
      if (result.commit_message) {
        console.log(`🔍 Analyzing commit message: "${result.commit_message}"`);
        const bumpType = determineBumpTypeFromMessage(result.commit_message);
        console.log(`  → Detected bump type: ${bumpType}`);
        highestBumpType = getHigherBumpType(highestBumpType, bumpType);
      }
    }
    console.log(`🎯 Final highest bump type: ${highestBumpType}`);
    
    // Set outputs
    core.setOutput('merged_repos', results.successful.map(r => r.repo).join(','));
    core.setOutput('success_count', results.successful.length.toString());
    core.setOutput('failed_repos', results.failed.map(r => r.repo).join(','));
    core.setOutput('merge_summary', JSON.stringify(results.summary));
    core.setOutput('highest_bump_type', highestBumpType);
    
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
