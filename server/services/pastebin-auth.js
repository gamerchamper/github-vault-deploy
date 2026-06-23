/**
 * Pastebin member login — obtains api_user_key from username/password.
 * @see https://pastebin.com/doc_api
 */
const pastebin = require('./pastebin');

function isConfigured() {
  return pastebin.isDevKeyConfigured();
}

async function login(username, password) {
  if (!username || !password) {
    throw new Error('Pastebin username and password are required');
  }
  const apiUserKey = await pastebin.loginMember(username, password);
  const profile = await pastebin.fetchUserProfile(apiUserKey);
  return {
    api_user_key: apiUserKey,
    profile: {
      id: profile.user_name,
      username: profile.user_name,
      displayName: profile.user_name,
      photos: profile.user_avatar_url ? [{ value: profile.user_avatar_url }] : [],
      provider: 'pastebin',
      account_type: profile.user_account_type,
    },
  };
}

module.exports = {
  isConfigured,
  login,
};
