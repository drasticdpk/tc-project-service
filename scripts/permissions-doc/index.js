/**
 * Generate a permissions.html document using the permission config from the Topcoder Connect App.
 *
 * Run by: `npm run generate:doc:permissions`
 *
 * For development purpose, run by `npm run generate:doc:permissions:dev` which would regenerate HTML on every update.
 */
import _ from 'lodash';
import fs from 'fs';
import path from 'path';
import handlebars from 'handlebars';
import { PERMISSION } from '../../src/permissions/constants';
import {
  PROJECT_MEMBER_ROLE,
} from '../../src/constants';

const docTemplatePath = path.resolve(__dirname, './template.hbs');
const outputDocPath = path.resolve(__dirname, '../../docs/permissions.html');

handlebars.registerHelper('istrue', value => value === true);

/**
 * Normalize all the project and topcoder role lists to the list of strings.
 *
 * - `projectRoles` can be `true` -> full list of Project Roles
 * - `projectRoles` may contain an object for `owner` role -> `owner` (string)
 * - `topcoderRoles` can be `true` -> full list of Topcoder Roles
 *
 * @param {Object} rule permission rule
 *
 * @returns {Object} permission rule with all the roles as strings
 */
function normalizePermissionRule(rule) {
  const normalizedRule = _.cloneDeep(rule);

  if (_.isArray(normalizedRule.projectRoles)) {
    normalizedRule.projectRoles = normalizedRule.projectRoles.map((role) => {
      if (_.isEqual(role, { role: PROJECT_MEMBER_ROLE.CUSTOMER, isPrimary: true })) {
        return 'owner';
      }

      return role;
    });
  }

  return normalizedRule;
}

/**
 * Normalize permission object which has "simple" and "full" shape into a "full" shape for consistency
 *
 * @param {Object} permission permission object
 *
 * @returns {Objects} permission object in the "full" shape with "allowRule" and "denyRule"
 */
function normalizePermission(permission) {
  let normalizedPermission = permission;

  if (!normalizedPermission.allowRule) {
    normalizedPermission = {
      meta: permission.meta,
      allowRule: _.omit(permission, 'meta'),
    };
  }

  if (normalizedPermission.allowRule) {
    normalizedPermission.allowRule = normalizePermissionRule(normalizedPermission.allowRule);
  }

  if (normalizedPermission.denyRule) {
    normalizedPermission.denyRule = normalizePermissionRule(normalizedPermission.denyRule);
  }

  return normalizedPermission;
}

const templateStr = fs.readFileSync(docTemplatePath).toString();
const renderDocument = handlebars.compile(templateStr);

const permissionKeys = _.keys(PERMISSION);
// prepare permissions without modifying data in constant `PERMISSION`
const allPermissions = permissionKeys.map((key) => {
  // add `key` to meta
  const meta = _.assign({}, PERMISSION[key].meta, {
    key,
  });

  // update `meta` to one with `key`
  return _.assign({}, PERMISSION[key], {
    meta,
  });
});
const groupsObj = _.groupBy(allPermissions, 'meta.group');
const groups = _.toPairs(groupsObj).map(([title, permissions]) => ({ title, permissions }));

groups.forEach((group) => {
  group.permissions = group.permissions.map(normalizePermission); // eslint-disable-line no-param-reassign
});

const data = {
  groups,
};

fs.writeFileSync(outputDocPath, renderDocument(data));