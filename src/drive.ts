// Copyright (c) Jupyter Development Team.
// Distributed under the terms of the Modified BSD License.

//TODO: Remove jquery dependency
import $ = require('jquery');

import {
  map, filter, toArray
} from 'phosphor/lib/algorithm/iteration';

import {
  Contents, utils 
} from '@jupyterlab/services';

import {
  showDialog
} from 'jupyterlab/lib/dialog';

import {
  driveApiRequest, driveReady
} from './gapi';

//TODO: Complete gapi typings and commit upstream
declare let gapi: any;

const RESOURCE_FIELDS='kind,id,name,mimeType,trashed,headRevisionId,'+
                      'parents,modifiedTime,createdTime,capabilities,'+
                      'webContentLink';

export
const RT_MIMETYPE = 'application/vnd.google-apps.drive-sdk';
export
const FOLDER_MIMETYPE = 'application/vnd.google-apps.folder';
export
const FILE_MIMETYPE = 'application/vnd.google-apps.file';

const MULTIPART_BOUNDARY = '-------314159265358979323846';


/* ****** Functions for uploading/downloading files ******** */

/**
 * Get a download URL for a file path.
 *
 * @param path - the path corresponding to the file.
 *
 * @returns a promise that resolves with the download URL.
 */
export
function urlForFile(path: string): Promise<string> {
  return new Promise<string>((resolve, reject)=>{
    getResourceForPath(path).then((resource: any)=>{
      resolve(resource.webContentLink);
    });
  });
}

/**
 * Given a path and `Contents.IModel`, upload the contents to Google Drive.
 *
 * @param path - the path to which to upload the contents.
 *
 * @param model - the `Contents.IModel` to upload.
 *
 * @param exisiting - whether the file exists.
 *
 * @returns a promise fulfulled with the `Contents.IModel` that has been uploaded,
 *   or throws an Error if it fails.
 */
export
function uploadFile(path: string, model: Contents.IModel, existing: boolean = false): Promise<Contents.IModel> {
  return new Promise<Contents.IModel>((resolve,reject)=>{
    let resourceReadyPromise = Promise.resolve(void 0);
    if(existing) {
      resourceReadyPromise = getResourceForPath(path)
    } else {
      resourceReadyPromise = new Promise<any>((resolve,reject)=>{
        let enclosingFolderPath =
          utils.urlPathJoin(...splitPath(path).slice(0,-1));
        let resource: any = fileResourceFromContentsModel(model);
        getResourceForPath(enclosingFolderPath)
        .then((parentFolderResource: any)=>{
          if(parentFolderResource.mimeType !== FOLDER_MIMETYPE) {
             throw new Error("Google Drive: expected a folder: "+path);
          }
          resource['parents'] = [parentFolderResource.id];
          resolve(resource);
        });
      });
    }
    resourceReadyPromise.then((resource: any)=>{
      //Construct the HTTP request: first the metadata,
      //then the content of the uploaded file

      let delimiter = '\r\n--' + MULTIPART_BOUNDARY + '\r\n';
      let closeDelim = '\r\n--' + MULTIPART_BOUNDARY + '--';
      let mime = resource.mimeType;
      switch(model.type) {
        case 'notebook':
          mime = 'application/ipynb';
          break;
        case 'directory':
          mime = FOLDER_MIMETYPE;
          break;
      }

      //Metatdata part
      let body = delimiter+'Content-Type: application/json\r\n\r\n';
      //Don't update metadata if the file already exists.
      if(!existing) {
        body += JSON.stringify(resource);
      }
      body += delimiter;

      //Content of the file
      body += 'Content-Type: ' + mime + '\r\n';
      if (mime === 'application/octet-stream') {
        body += 'Content-Transfer-Encoding: base64\r\n';
      }
      //TODO: this puts extra quotes around strings.
      body +='\r\n' + JSON.stringify(model.content) + closeDelim;

      let apiPath = '/upload/drive/v3/files';
      let method = 'POST';

      if(existing) {
        method = 'PATCH';
        apiPath = apiPath+'/'+resource.id;
      }

      let request = gapi.client.request({
        path: apiPath,
        method: method,
        params: {
          uploadType: 'multipart',
          fields: RESOURCE_FIELDS
          },
        headers: {
          'Content-Type': 'multipart/related; boundary="' +
            MULTIPART_BOUNDARY + '"'
          },
        body: body
      });

      driveApiRequest(request).then( (result: any)=>{
        console.log("gapi: uploaded document to "+result.id);
        contentsModelFromFileResource(result, path, true).then((contents: Contents.IModel)=>{
          resolve(contents);
        });
      });
    });
  });
}

/**
 * Given a files resource, construct a Contents.IModel.
 *
 * @param resource - the files resource.
 *
 * @param path - the path at which the resource exists in the filesystem.
 *   This should include the name of the file itself.
 *
 * @param includeContents - whether to download the actual text/json/binary
 *   content from the server. This takes much more bandwidth, so should only
 *   be used when required.
 *
 * @returns a promise fulfilled with the Contents.IModel for the resource.
 */
export
function contentsModelFromFileResource(resource: any, path: string, includeContents: boolean = false): Promise<Contents.IModel> {
  return new Promise<Contents.IModel>((resolve,reject)=>{

    //Handle the case of getting the contents of a directory
    if(resource.mimeType === FOLDER_MIMETYPE) {
      //enter contents metadata
      let contents: any = {
        name: resource.name,
        path: path,
        type: 'directory',
        writable: resource.capabilities.canEdit,
        created: String(resource.createdTime),
        last_modified: String(resource.modifiedTime),
        mimetype: null,
        content: null,
        format: 'json'
      };

      //get directory listing if applicable
      if (includeContents) {
        let fileList: any[] = [];
        searchDirectory(path).then( (resources: any[])=>{
          let currentContents = Promise.resolve({});

          for(let i = 0; i<resources.length; i++) {
            let currentResource = resources[i];
            let resourcePath = path ?
                               path+'/'+currentResource.name :
                               currentResource.name;
            currentContents = contentsModelFromFileResource(
              currentResource, resourcePath, false);
            currentContents.then((contents: Contents.IModel)=>{
              fileList.push(contents);
            });
          }
          currentContents.then(()=>{
            contents.content = fileList;
            resolve(contents);
          });
        });
      } else {
        resolve(contents);
      }
    } else { //Handle the case of getting the contents of a file.
      let contentType: Contents.ContentType;
      let mimeType: string;
      let format: Contents.FileFormat;
      if(resource.mimeType === 'application/ipynb' ||
         resource.mimeType === 'application/json') {
        contentType = 'notebook';
        format = 'json';
        mimeType = null;
      } else if(resource.mimeType === 'text/plain') {
        contentType = 'file';
        format = 'text';
        mimeType = 'text/plain';
      } else {
        contentType = 'file';
        format = 'base64';
        mimeType = 'application/octet-stream';
      }
      let contents: any = {
        name: resource.name,
        path: path,
        type: contentType,
        writable: resource.capabilities.canEdit,
        created: String(resource.createdTime),
        last_modified: String(resource.modifiedTime),
        mimetype: mimeType,
        content: null,
        format: format
      };
      //Download the contents from the server if necessary.
      if(includeContents) {
        downloadResource(resource).then((result: any)=>{
          contents.content = result;
          resolve(contents);
        }).catch(()=>{
          console.log("Google Drive: unable to download contents");
        });
      } else {
        resolve(contents);
      }
    }
  });
}

/**
 * Given a path, get a `Contents.IModel` corresponding to that file.
 *
 * @param path - the path of the file.
 *
 * @param includeContents - whether to include the binary/text/contents of the file.
 *   If false, just get the metadata.
 *
 * @returns a promise fulfilled with the `Contents.IModel` of the appropriate file.
 *   Otherwise, throws an error.
 */
export
function contentsModelForPath(path: string, includeContents: boolean = false): Promise<Contents.IModel> {
  return new Promise<Contents.IModel>((resolve,reject)=>{
    getResourceForPath(path).then((resource: any)=>{
      contentsModelFromFileResource(resource, path, includeContents)
      .then((contents: Contents.IModel)=>{
        resolve(contents);
      });
    });
  });
}


/* ********* Functions for file creation/deletion ************** */

/**
 * Give edit permissions to a Google drive user.
 *
 * @param fileId - the ID of the file.
 *
 * @param emailAddress - the email address of the user for which
 *   to create the permissions.
 *
 * @returns a promise fulfilled when the permissions are created.
 */
export
function createPermissions (fileId: string, emailAddress: string ): Promise<void> {
  return new Promise<void> ((resolve,reject) => {
    let permissionRequest = {
      'type' : 'user',
      'role' : 'writer',
      'emailAddress': emailAddress
    }
    let request = gapi.client.drive.permissions.create({
      'fileId': fileId,
      'emailMessage' : fileId,
      'sendNotificationEmail' : true,
      'resource': permissionRequest
    });
    driveApiRequest(request).then( (result : any) => {
      console.log("gapi: created permissions for "+emailAddress);
      resolve();
    });
  });
}

/**
 * Create a new document for realtime collaboration.
 * This file is not associated with a particular filetype,
 * and is not downloadable/readable.  Realtime documents
 * may also be associated with other, more readable documents.
 *
 * @returns a promise fulfilled with the fileId of the
 *   newly-created realtime document.
 */
export
function createRealtimeDocument(): Promise<string> {
  return new Promise( (resolve, reject) => {
    let request = gapi.client.drive.files.create({
        'resource': {
          mimeType: RT_MIMETYPE,
          name: 'jupyterlab_realtime_file'
          }
    })
    driveApiRequest(request).then( (result : any)=>{
      let fileId : string = result.id;
      console.log("gapi: created realtime document "+fileId);
      resolve(fileId);
    });
  });
}

/**
 * Load the realtime document associated with a file.
 *
 * @param fileId - the ID of the realtime file on Google Drive.
 *
 * @returns a promise fulfilled with the realtime document model.
 */
export
function loadRealtimeDocument( fileId : string): Promise<gapi.drive.realtime.Document> {
  return new Promise((resolve, reject) =>{
    driveReady.then(()=>{
      console.log("gapi : attempting to load realtime file " + fileId);
      gapi.drive.realtime.load( fileId, (doc : gapi.drive.realtime.Document ):any => {
        resolve(doc);
      });
    });
  });
}

/**
 * Delete a file from the users Google Drive.
 *
 * @param path - the path of the file to delete.
 *
 * @returns a promise fulfilled when the file has been deleted.
 */
export
function deleteFile(path: string): Promise<void> {
  return new Promise<void>((resolve, reject)=>{
    getResourceForPath(path).then((resource: any)=>{
      let request: any = gapi.client.drive.files.delete({fileId: resource.id});
      driveApiRequest(request, 204).then(()=>{
        resolve();
      });
    }).catch((result)=>{
      console.log('Google Drive: unable to delete file: '+path);
      reject();
    });
  });
}

/* ****** Functions for file system querying/manipulation ***** */

/**
 * Search a directory.
 *
 * @param path - the path of the directory on the server.
 *
 * @param query - a query string, following the format of
 *   query strings for the Google Drive v3 API, which
 *   narrows down search results. An empty query string
 *   corresponds to just listing the contents of the directory.
 *
 * @returns a promise fulfilled with a list of files resources,
 *   corresponding to the files that are in the directory and
 *   match the query string.
 */
export
function searchDirectory(path: string, query: string = ''): Promise<any[]> {
  return new Promise<any[]>((resolve, reject)=>{
    getResourceForPath(path).then((resource: any)=>{

      //Check to make sure this is a folder.
      if(resource.mimeType !== FOLDER_MIMETYPE) {
        throw new Error("Google Drive: expected a folder: "+path);
      }
      //Construct the query
      let fullQuery: string = '\''+resource.id+'\' in parents '+
                              'and trashed = false';
      if(query) fullQuery += ' and '+query;

      let request = gapi.client.drive.files.list({
        q: fullQuery,
        fields: 'files('+RESOURCE_FIELDS+')'
      });
      driveApiRequest(request).then((result: any)=>{
        resolve(result.files);
      });
    });
  });
}

/**
 * Move a file in Google Drive. Can also be used to rename the file.
 *
 * @param oldPath - The initial location of the file (where the path
 *   includes the filename).
 *
 * @param oldPath - The new location of the file (where the path
 *   includes the filename).
 *
 * @returns a promise fulfilled with the `Contents.IModel` of the appropriate file.
 *   Otherwise, throws an error.
 */
export
function moveFile(oldPath: string, newPath: string): Promise<Contents.IModel> {
  if( oldPath === newPath ) {
    return contentsModelForPath(oldPath);
  } else {
    return new Promise<Contents.IModel>((resolve, reject)=>{
      let pathComponents = splitPath(newPath);
      let newFolderPath = utils.urlPathJoin(...pathComponents.slice(0,-1));

      //Get a promise that resolves with the resource in the current position.
      let resourcePromise = getResourceForPath(oldPath)
      //Get a promise that resolves with the resource of the new folder.
      let newFolderPromise = getResourceForPath(newFolderPath);

      //Check the new path to make sure there isn't already a file
      //with the same name there.
      let newName = pathComponents.slice(-1)[0];
      let directorySearchPromise =
        searchDirectory(newFolderPath, 'name = \''+newName+'\'');

      //Once we have all the required information,
      //update the metadata with the new parent directory
      //for the file.
      Promise.all([resourcePromise, newFolderPromise, directorySearchPromise])
      .then((values)=>{
        let resource = values[0];
        let newFolder = values[1];
        let directorySearch = values[2];

        if(directorySearch.length !== 0) {
            reject(void 0);
        } else {
          let request: any = gapi.client.drive.files.update({
            fileId: resource.id,
            addParents: newFolder.id,
            removeParents: resource.parents[0],
            name: newName
          });
          driveApiRequest(request).then(()=>{
            contentsModelForPath(newPath)
            .then((contents: Contents.IModel)=>{
              resolve(contents);
            });
          });
        }
      });
    });
  }
}


/* ******** Functions for dealing with revisions ******** */

/**
 * List the revisions for a file in Google Drive.
 *
 * @param path - the path of the file.
 *
 * @returns a promise fulfilled with a list of `Contents.ICheckpointModel`
 *   that correspond to the file revisions stored on drive.
 */
export
function listRevisions(path: string): Promise<Contents.ICheckpointModel[]> {
  return new Promise<Contents.ICheckpointModel[]>((resolve, reject)=>{
    getResourceForPath(path).then((resource: any)=>{
      let request: any = gapi.client.drive.revisions.list({
        fileId: resource.id,
        fields: 'revisions(id, modifiedTime, keepForever)' //NOT DOCUMENTED
      });
      driveApiRequest(request).then((result: any)=>{
        let revisions = map(filter(result.revisions, (revision: any)=>{
          return revision.keepForever;
        }), (revision: any)=>{
          return { id: revision.id, last_modified: revision.modifiedTime }
        });
        resolve(toArray(revisions));
      });
    });
  });
}

/**
 * Tell Google drive to keep the current revision. Without doing
 * this the revision would eventually be cleaned up.
 *
 * @param path - the path of the file to pin.
 *
 * @returns a promise fulfilled with an `ICheckpointModel` corresponding
 *   to the newly pinned revision.
 */
export
function pinCurrentRevision(path: string): Promise<Contents.ICheckpointModel> {
  return new Promise<Contents.ICheckpointModel>((resolve, reject)=>{
    getResourceForPath(path).then((resource: any)=>{
      let request: any = gapi.client.drive.revisions.update({
        fileId: resource.id,
        revisionId: resource.headRevisionId,
        keepForever: true
      });
      driveApiRequest(request).then((revision: any)=>{
        resolve ({ id: revision.id, last_modified: revision.modifiedTime });
      });
    });
  });
}

/**
 * Tell Google drive not to keep the current revision.
 * Eventually the revision will then be cleaned up.
 *
 * @param path - the path of the file to unpin.
 *
 * @param revisionId - the id of the revision to unpin.
 *
 * @returns a promise fulfilled when the revision is unpinned.
 */
export
function unpinRevision(path: string, revisionId: string): Promise<void> {
  return new Promise<void>((resolve, reject)=>{
    getResourceForPath(path).then((resource: any)=>{
      let request: any = gapi.client.drive.revisions.update({
        fileId: resource.id,
        revisionId: revisionId,
        keepForever: false
      });
      driveApiRequest(request).then(()=>{
        resolve ();
      });
    });
  });
}

/**
 * Revert a file to a particular revision id.
 *
 * @param path - the path of the file.
 *
 * @param revisionId - the id of the revision to revert.
 *
 * @returns a promise fulfilled when the file is reverted.
 */
export
function revertToRevision(path: string, revisionId: string): Promise<void> {
  return new Promise<void>((resolve, reject)=>{
    //Get the correct file resource
    getResourceForPath(path).then((resource: any)=>{

      //Construct the request for a specific revision to the file.
      let downloadRequest: any = gapi.client.drive.revisions.get({
       fileId: resource.id,
       revisionId: revisionId,
       alt: 'media'
      });
      //Make the request
      driveApiRequest(downloadRequest).then((result: any)=>{

        let contentType: Contents.ContentType;
        let mimeType: string;
        let format: Contents.FileFormat;
        if(resource.mimeType === 'application/ipynb' ||
           resource.mimeType === 'application/json') {
          contentType = 'notebook';
          format = 'json';
          mimeType = null;
        } else if(resource.mimeType === 'text/plain') {
          contentType = 'file';
          format = 'text';
          mimeType = 'text/plain';
        } else {
          contentType = 'file';
          format = 'base64';
          mimeType = 'application/octet-stream';
        }
        //Reconstruct the Contents.IModel from the retrieved contents
        let contents: Contents.IModel = {
          name: resource.name,
          path: path,
          type: contentType,
          writable: resource.capabilities.canEdit,
          created: String(resource.createdTime),
          //TODO What is the appropriate modified time?
          last_modified: String(resource.modifiedTime),
          mimetype: mimeType,
          content: result,
          format: format
        };

        //Reupload the reverted file to the head revision/
        uploadFile(path, contents, true).then(()=>{
          resolve();
        });
      });
    });
  });
}

/* *********Utility functions ********* */

/**
 * Construct a minimal files resource object from a
 * contents model.
 *
 * @param contents - The contents model.
 *
 * @returns a files resource object for the Google Drive API.
 *
 * #### Notes
 * This does not include any of the binary/text/json content of the
 * `contents`, just some metadata (`name` and `mimeType`).
 */
function fileResourceFromContentsModel(contents: Contents.IModel): any {
  let mimeType = '';
  switch (contents.type) {
    case 'directory':
      mimeType = FOLDER_MIMETYPE;
      break;
    case 'notebook':
      mimeType = 'application/ipynb';
      break;
    case 'file':
      if(contents.format) {
        if(contents.format === 'text')
          mimeType = 'text/plain';
        else if (contents.format === 'base64')
          mimeType = 'application/octet-stream';
      }
      break;
    default:
      throw new Error('Invalid contents type');
  }
  return {
    name: contents.name,
    mimeType: mimeType
  };
}

/**
 * Obtains the Google Drive Files resource for a file or folder relative
 * to the a given folder.  The path should be a file or a subfolder, and
 * should not contain multiple levels of folders (hence the name
 * pathComponent).  It should also not contain any leading or trailing
 * slashes.
 *
 * @param pathComponent - The file/folder to find
 *
 * @param type - type of resource (file or folder)
 *
 * @param folderId - The Google Drive folder id
 *
 * @returns A promise fulfilled by either the files resource for the given
 *   file/folder, or rejected with an Error object.
 */
function getResourceForRelativePath(pathComponent: string, folderId: string): Promise<any> {
  return new Promise<any>((resolve,reject)=>{
    //Construct a search query for the file at hand.
    let query = 'name = \'' + pathComponent + '\' and trashed = false '
                + 'and \'' + folderId + '\' in parents';
    //Construct a request for the files matching the query
    let request: string = gapi.client.drive.files.list({
      q: query,
      fields: 'files('+RESOURCE_FIELDS+')'
    });
    //Make the request
    return driveApiRequest(request).then((result: any)=>{
      let files: any = result.files;
      if (!files || files.length === 0) {
        throw new Error(
          "Google Drive: cannot find the specified file/folder: "
          +pathComponent);
      } else if (files.length > 1) {
        throw new Error(
          "Google Drive: multiple files/folders match: "
          +pathComponent);
      }
      resolve(files[0]);
    });
  });
}

/**
 * Given the unique id string for a file in Google Drive,
 * get the files resource metadata associated with it.
 *
 * @param id - The file ID.
 *
 * @returns A promise that resolves with the files resource
 *   corresponding to `id`.
 */
function resourceFromFileId(id: string): Promise<any> {
  return new Promise<any>((resolve,reject)=>{
    let request: any = gapi.client.drive.files.get({
     fileId: id,
     fields: RESOURCE_FIELDS
    });
    driveApiRequest(request).then((result: any)=>{
        resolve(result);
    });
  });
}

/**
 * Split a path into path components
 */
function splitPath(path: string): string[] {
    return path.split('/').filter((s,i,a) => (Boolean(s)));
};

/**
 * Gets the Google Drive Files resource corresponding to a path.  The path
 * is always treated as an absolute path, no matter whether it contains
 * leading or trailing slashes.  In fact, all leading, trailing and
 * consecutive slashes are ignored.
 *
 * @param path - The path of the file.
 *
 * @param type - The type (file or folder)
 *
 * @returns A promise fulfilled with the files resource for the given path.
 *   or an Error object on error.
 */
export
function getResourceForPath(path: string): Promise<any> {
  return new Promise<any>((resolve,reject)=>{
    let components = splitPath(path);

    if (components.length === 0) {
      //Handle the case for the root folder
      resourceFromFileId('root').then((resource:any)=>{
        resolve(resource);
      });
    } else {
      //Loop through the path components and get the resource for each
      //one, verifying that the path corresponds to a valid drive object.

      //Utility function that gets the file resource object given its name,
      //whether it is a file or a folder, and a promise for the resource 
      //object of its containing folder.
      let getResource = function(pathComponent: string, parentResource: Promise<any>): Promise<any> {
        return parentResource.then((resource: any)=>{
          return getResourceForRelativePath(pathComponent, resource['id']);
        });
      }

      //We start with the root directory:
      let currentResource: Promise<any> = Promise.resolve({id: 'root'});

      //Loop over the components, updating the current resource
      for (let i = 0; i < components.length; i++) {
        let component = components[i];
        currentResource = getResource(component, currentResource);
      }

      //Resolve with the final value of currentResource.
      currentResource.then( (resource: any)=>{resolve(resource);});
    }
  });
}

/**
 * Download the contents of a file from Google Drive.
 *
 * @param resource - the files resource metadata object.
 *
 * @returns a promise fulfilled with the contents of the file.
 */
function downloadResource(resource: any): Promise<any> {
  return new Promise<any>((resolve,reject)=>{
    let request: any = gapi.client.drive.files.get({
     fileId: resource.id,
     alt: 'media'
    });
    driveApiRequest(request).then((result: any)=>{
      resolve(result);
    });
  });
}
