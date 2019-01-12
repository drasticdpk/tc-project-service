

import validate from 'express-validation';
import _ from 'lodash';
import Joi from 'joi';
import config from 'config';
import { middleware as tcMiddleware } from 'tc-core-library-js';
import models from '../../models';
import util from '../../util';
import { PROJECT_MEMBER_ROLE, PROJECT_MEMBER_MANAGER_ROLES,
  MANAGER_ROLES, INVITE_STATUS, EVENT, BUS_API_EVENT } from '../../constants';
import { createEvent } from '../../services/busApi';


/**
 * API to create member invite to project.
 *
 */
const permissions = tcMiddleware.permissions;

const addMemberValidations = {
  body: {
    param: Joi.object().keys({
      userIds: Joi.array().items(Joi.number()).optional().min(1),
      emails: Joi.array().items(Joi.string().email()).optional().min(1),
      role: Joi.any().valid(_.values(PROJECT_MEMBER_ROLE)).required(),
    }).required(),
  },
};

module.exports = [
  // handles request validations
  validate(addMemberValidations),
  permissions('projectMemberInvite.create'),
  (req, res, next) => {
    const invite = req.body.param;

    if (!invite.userIds && !invite.emails) {
      const err = new Error('Either userIds or emails are required');
      err.status = 400;
      return next(err);
    }

    if (!util.hasRoles(req, MANAGER_ROLES) && invite.role !== PROJECT_MEMBER_ROLE.CUSTOMER) {
      const err = new Error(`You are not allowed to invite user as ${invite.role}`);
      err.status = 403;
      return next(err);
    }

    const members = req.context.currentProjectMembers;
    const projectId = _.parseInt(req.params.projectId);

    const promises = [];
    if (invite.userIds) {
      // remove members already in the team
      _.remove(invite.userIds, u => _.some(members, m => m.userId === u));
        // permission:
        // user has to have constants.MANAGER_ROLES role
        // to be invited as PROJECT_MEMBER_ROLE.MANAGER
      if (invite.role === PROJECT_MEMBER_ROLE.MANAGER) {
        _.forEach(invite.userIds, (userId) => {
          req.log.info(userId);
          promises.push(util.getUserRoles(userId, req.log, req.id));
        });
      }
    }

    if (invite.emails) {
        // email invites can only be used for CUSTOMER role
      if (invite.role !== PROJECT_MEMBER_ROLE.CUSTOMER) {  // eslint-disable-line no-lonely-if
        const err = new Error(`Emails can only be used for ${PROJECT_MEMBER_ROLE.CUSTOMER}`);
        err.status = 400;
        return next(err);
      }
    }

    if (promises.length === 0) {
      promises.push(Promise.resolve());
    }
    return Promise.all(promises).then((rolesList) => {
      if (!!invite.userIds && _.includes(PROJECT_MEMBER_MANAGER_ROLES, invite.role)) {
        req.log.debug('Chekcing if userId is allowed as manager');
        const forbidUserList = [];
        _.zip(invite.userIds, rolesList).forEach((data) => {
          const [userId, roles] = data;

          if (!util.hasIntersection(MANAGER_ROLES, roles)) {
            forbidUserList.push(userId);
          }
        });
        if (forbidUserList.length > 0) {
          const err = new Error(`${forbidUserList.join()} cannot be added with a Manager role to the project`);
          err.status = 403;
          return next(err);
        }
      }
      return models.ProjectMemberInvite.getPendingInvitesForProject(projectId)
        .then((invites) => {
          const data = {
            projectId,
            role: invite.role,
            status: INVITE_STATUS.PENDING,
            createdBy: req.authUser.userId,
            updatedBy: req.authUser.userId,
          };
          const invitePromises = [];
          if (invite.userIds) {
            // remove invites for users that are invited already
            _.remove(invite.userIds, u => _.some(invites, i => i.userId === u));
            invite.userIds.forEach((userId) => {
              const dataNew = _.clone(data);
              _.assign(dataNew, {
                userId,
              });
              invitePromises.push(models.ProjectMemberInvite.create(dataNew));
            });
          }
          data.userId = null;

          if (invite.emails) {
            // remove invites for users that are invited already
            _.remove(invite.emails, u => _.some(invites, i => i.email === u));
            invite.emails.forEach((email) => {
              const dataNew = _.clone(data);
              _.assign(dataNew, {
                email,
              });
              invitePromises.push(models.ProjectMemberInvite.create(dataNew));
            });
          }

          if (invitePromises.length === 0) {
            return [];
          }

          req.log.debug('Creating invites');
          const emailEventType = BUS_API_EVENT.PROJECT_MEMBER_EMAIL_INVITE_CREATED;
          return models.sequelize.Promise.all(invitePromises)
            .then((values) => {
              values.forEach((v) => {
                req.app.emit(EVENT.ROUTING_KEY.PROJECT_MEMBER_INVITE_CREATED, {
                  req,
                  userId: v.userId,
                  email: v.email,
                });
                req.app.services.pubsub.publish(
                        EVENT.ROUTING_KEY.PROJECT_MEMBER_INVITE_CREATED,
                        v,
                        { correlationId: req.id },
                    );
                // send email invite (async)
                if (v.email) {
                  models.Project
                  .find({
                    where: { id: projectId },
                    raw: true,
                  })
                  .then((_project) => {
                    createEvent(emailEventType,
                      {
                        data: {
                          connectURL: config.get('connectUrl'),
                          accountsAppURL: config.get('accountsAppUrl'),
                          subject: config.get('inviteEmailSubject'),
                          projects: [
                            {
                              name: _project.name,
                              projectId,
                              sections: [
                                {
                                  EMAIL_INVITES: true,
                                  title: config.get('inviteEmailSectionTitle'),
                                  projectName: _project.name,
                                  projectId,
                                },
                              ],
                            },
                          ],
                        },
                        recipients: [v.email],
                        version: 'v3',
                        from: {
                          name: config.get('EMAIL_INVITE_FROM_NAME'),
                          email: config.get('EMAIL_INVITE_FROM_EMAIL'),
                        },
                        categories: [`${process.env.NODE_ENV}:${emailEventType}`.toLowerCase()],
                      }, req.log);
                  });
                }
              });
              return values;
            });
        });
    })
    .then(values => res.status(201).json(util.wrapResponse(req.id, values, null, 201)))
    .catch(err => next(err));
  },
];